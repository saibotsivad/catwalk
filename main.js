(function () {
	'use strict'

	// See ./README.md for details.

	// Prevent multiple loads, this is a singleton instance.
	if (globalThis.Catwalk) return;

	// NOTE: This value gets replaced during build.
	const WORKER_CODE = '$$$TEMPLATE:worker.js$$$'

	const MessageType = {
		ERROR: 'error',
		READY: 'ready',
		RESULT: 'result',
		STATUS: 'status',
		STREAM_END: 'stream-end',
		STREAM_TOKEN: 'stream-token',
	}

	const ModelType = {
		EMBEDDING: 'embedding',
		LM: 'llm',
		TOKENIZER: 'tokenizer',
	}

	const ModelStatus = {
		STARTING: 'starting',
		PROGRESS: 'progress', // { percent: number }
		READY: 'ready',
		UNLOADED: 'unloaded',
	}

	// ---- IndexedDB helpers for model registry persistence ----

	const IDB_NAME = 'catwalk'
	const IDB_STORE = 'registry'

	const openRegistry = () => new Promise((resolve, reject) => {
		const req = indexedDB.open(IDB_NAME, 1)
		req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})

	const registryGet = async (key) => openRegistry()
		.then(db => new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, 'readonly')
			const req = tx.objectStore(IDB_STORE).get(key)
			req.onsuccess = () => resolve(req.result ?? null)
			req.onerror = () => reject(req.error)
		}))

	const registrySet = async (key, value) => openRegistry()
		.then(db => new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, 'readwrite')
			tx.objectStore(IDB_STORE).put(value, key)
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		}))

	const registryClear = async (key, value) => openRegistry()
		.then(db => new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, 'readwrite')
			tx.objectStore(IDB_STORE).clear()
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		}))

	// ---- Internal State ----
	let worker = null
	let blobURL = null
	let pending = new Map()        // id => { resolve, reject }
	let streams = new Map()        // id => { controller }  (for async iterators)
	let modelRegistry = new Map()  // modelName => { modelType, status, [ percent, file ] }
	let ready = false
	let progressCallbacks = []

	// --- Message Handling ---
	const sendMessage = async (type, params) => {
		const id = crypto.randomUUID()
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
			worker.postMessage({ type, id, ...params })
		})
	}
	const handleMessage = (data) => {
		const { type, id } = data
		if (type === MessageType.STATUS) {
			const registry = {
				modelType: data.payload.modelType,
				status: ModelStatus.STARTING,
				percent: 0,
			}
			if (data.payload.file) {
				registry.file = data.payload.file
			}
			if ([ 'initiate', 'download', 'progress', 'done' ].includes(data.payload.status)) {
				registry.status = ModelStatus.PROGRESS
				registry.percent = data.payload.progess || (data.payload.status === 'done' ? 100 : 0.1)
			} else if (data.payload.status === 'ready') {
				registry.status = ModelStatus.READY
				delete registry.percent
			}
			modelRegistry.set(registry)
			if (progressCallbacks.length) {
				for (const cb of progressCallbacks) cb({ modelName: data.payload.modelName, ...registry })
			}
			return
		}
		if (type === MessageType.RESULT) {
			const pen = pending.get(id)
			if (pen) {
				pen.resolve(data.payload)
				pending.delete(id)
			}
			return
		}
		if (type === MessageType.ERROR) {
			const pen = pending.get(id)
			if (pen) {
				pen.reject(new Error(data.error))
				pending.delete(id)
			}
			// Also close any associated stream
			const stream = streams.get(id)
			if (stream) {
				stream.controller.error(new Error(data.error))
				streams.delete(id)
			}
			return
		}
		if (type === MessageType.STREAM_TOKEN) {
			const stream = streams.get(id)
			if (stream) {
				stream.controller.enqueue(data.payload)
			}
			return
		}
		if (type === MessageType.STREAM_END) {
			const stream = streams.get(id)
			if (stream) {
				stream.controller.close()
				streams.delete(id)
			}
			return
		}
	}

	// --- Model management ---
	const persistRegistry = async () => {
		const obj = Object.fromEntries(modelRegistry)
		await registrySet('modelRegistry', obj)
	}
	const assertModelType = (modelName, expectedType) => {
		const actual = modelRegistry.get(modelName)
		if (!actual) {
			throw new Error(`Model not registered: ${modelName}`)
		}
		if (actual !== expectedType) {
			throw new Error(`${modelName} is a ${actual}, not a ${expectedType}`)
		}
	}
	const loadModel = async (modelType, modelName) => {
		const result = await sendMessage('load', { modelType, modelName })
		modelRegistry.set(modelName, modelType)
		await persistRegistry()
		return result
	}
	const unloadModel = async (modelName) => {
		const result = await sendMessage('unload', { modelName })
		modelRegistry.delete(modelName)
		await persistRegistry()
		if (progressCallbacks.length) {
			for (const cb of progressCallbacks) cb({ modelName, status: ModelStatus.UNLOADED })
		}
		return result
	}
	const getLoadedModels = async () => {
		// TODO more like this?
		// getModelsInfo() => Promise<{ name: string, status: enum, type: ModelType }>
		return sendMessage('loaded', {})
	}
	const isModelCached = (modelName) => {
		return modelRegistry.has(modelName)
	}
	const getModelType = (modelName) => {
		return modelRegistry.get(modelName) ?? null
	}
	const clearCache = async () => {
		modelRegistry.clear()
		await registryClear()
	}

	// --- Tokenizer ---
	const tokenize = async (modelName, text, configs) => {
		assertModelType(modelName, 'tokenizer')
		return sendMessage('tokenize', { modelName, text, configs })
	}
	const detokenize = async (modelName, tokens) => {
		assertModelType(modelName, 'tokenizer')
		return sendMessage('detokenize', { modelName, tokens })
	}

	// --- Generation ---
	const abort = (generationId) => {
		worker.postMessage({ type: 'abort', generationId })
	}
	async function *generate(modelName, tokenizerName, tokens, config = {}) {
		assertModelType(modelName, 'llm')
		assertModelType(tokenizerName, 'tokenizer')

		const id = crypto.randomUUID()

		// Create a ReadableStream that the worker will push tokens into
		let streamController
		const stream = new ReadableStream({
			start(controller) {
				streamController = controller
			}
		})

		streams.set(id, { controller: streamController })

		// Tell the worker to start generating
		worker.postMessage({
			type: 'generate',
			id,
			modelName,
			tokenizerName,
			tokens,
			config,
		})

		// Yield tokens as they arrive
		const reader = stream.getReader()
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				yield value
			}
		} finally {
			reader.releaseLock()
			streams.delete(id)
		}
	}

	// --- Embedding ---
	const embed = async (modelName, text) => {
		assertModelType(modelName, 'embeddings');
		return sendMessage('embed', { modelName, text });
	}

	// --- INIT ---
	let catwalkHasInitialized = false
	const init = async () => {
		if (catwalkHasInitialized) return
		catwalkHasInitialized = true

		// Rehydrate model registry from IndexedDB
		const saved = await registryGet('modelRegistry')
		if (saved) {
			for (const [name, type] of Object.entries(saved)) {
				modelRegistry.set(name, type)
			}
		}

		// Spin up the worker
		const blob = new Blob([ WORKER_CODE ], { type: 'application/javascript' })
		blobURL = URL.createObjectURL(blob)
		worker = new Worker(blobURL, { type: 'module' })

		worker.onmessage = (e) => handleMessage(e.data)
		worker.onerror = (e) => console.error('[Catwalk] Worker error:', e)

		// Wait for worker to be ready
		await new Promise((resolve) => {
			const handler = (e) => {
				if (e.data.type === 'ready') {
					worker.removeEventListener('message', handler)
					resolve()
				}
			}
			worker.addEventListener('message', handler)
			worker.postMessage({ type: 'init' })
		})
		ready = true
	}

	const waitForInit = (cb) => {
		return async (...params) => {
			await init()
			return cb(...params)
		}
	}

	// --- GLOBAL ---
	globalThis.Catwalk = {
		version: '0.0.0',
		ModelType,

		// Model lifecycle
		loadModel: waitForInit(loadModel),
		unloadModel: waitForInit(unloadModel),
		getLoadedModels: waitForInit(getLoadedModels),
		// TODO do we need this?
		// uncacheModel: (name: string) => Promise<void>
		//isModelCached,
		onProgress: (cb) => {
			if (typeof cb !== 'function') {
				console.error('Catwalk.onProgress expects a callback function.')
				return
			}
			if (progressCallbacks.length) {
				console.debug('Adding multiple "onProgress" callback functions.')
			}
			progressCallbacks.push(cb)
		},

		// Tokenizer
		tokenize: waitForInit(tokenize),
		detokenize: waitForInit(detokenize),

		// Embedder
		embed: waitForInit(embed),

		// Language Model
		generate: waitForInit(generate),
		abort: waitForInit(abort),
	}
})()
