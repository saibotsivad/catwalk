import {
	AutoTokenizer,
	AutoModelForCausalLM,
	pipeline,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers'

const models = new Map()

const MessageType = {
	ERROR: 'error',
	READY: 'ready',
	RESULT: 'result',
	STATUS: 'status',
	STREAM_END: 'stream-end',
	STREAM_TOKEN: 'stream-token',
}

function sendMessage(type, id, payload) {
	self.postMessage({ type, id, payload })
}
function sendError(id, error) {
	self.postMessage({ type: MessageType.ERROR, id, error })
}

async function handleInit() {
	self.postMessage({ type: 'ready' })
}

async function handleLoadModel(id, { modelType, modelName }) {
	try {
		let instance

		if (modelType === 'tokenizer') {
			instance = await AutoTokenizer.from_pretrained(modelName, {
				progress_callback: ({ status, file, progress }) => {
					self.postMessage({
						type: MessageType.STATUS,
						payload: { modelName, modelType, status, file, progress },
					})
				}
			})
		} else if (modelType === 'llm') {
			instance = await AutoModelForCausalLM.from_pretrained(modelName, {
				progress_callback: ({ status, file, progress }) => {
					self.postMessage({
						type: MessageType.STATUS,
						payload: { modelName, modelType, status, file, progress },
					})
				}
			})
		} else if (modelType === 'embeddings') {
			instance = await pipeline('feature-extraction', modelName, {
				progress_callback: ({ status, file, progress }) => {
					self.postMessage({
						type: MessageType.STATUS,
						payload: { modelName, modelType, status, file, progress },
					})
				}
			})
		} else {
			throw new Error('Unknown model type: ' + modelType)
		}

		models.set(modelName, { type: modelType, instance })
		sendMessage(MessageType.RESULT, id, { modelType, modelName })
	} catch (err) {
		sendError(id, err.message)
	}
}

function handleUnloadModel(id, { modelName }) {
	models.delete(modelName)
	sendMessage(MessageType.RESULT, id, { modelName })
}

function handleGetLoadedModels(id) {
	const loaded = []
	for (const [name, { type }] of models) {
		loaded.push({ modelName: name, modelType: type })
	}
	sendMessage(MessageType.RESULT, id, loaded)
}

function handleTokenize(id, { modelName, text, configs }) {
	const entry = models.get(modelName)
	if (!entry) {
		sendError(id, 'Model not loaded: ' + modelName)
		return
	}
	if (entry.type !== 'tokenizer') {
		sendError(id, modelName + ' is not a tokenizer')
		return
	}
	try {
		const { input_ids } = entry.instance(text, configs)
		sendMessage(MessageType.RESULT, id, input_ids.tolist()[0])
	} catch (err) {
		sendError(id, err.message)
	}
}

function handleDetokenize(id, { modelName, tokens, configs }) {
	const entry = models.get(modelName)
	if (!entry) {
		sendError(id, 'Model not loaded: ' + modelName)
		return
	}
	if (entry.type !== 'tokenizer') {
		sendError(id, modelName + ' is not a tokenizer')
		return
	}
	try {
		const text = entry.instance.decode(tokens, configs)
		sendMessage(MessageType.RESULT, id, text)
	} catch (err) {
		sendError(id, err.message)
	}
}

let abortControllers = new Map()

async function handleGenerate(id, { modelName, tokenizerName, tokens, config }) {
	const llmEntry = models.get(modelName)
	if (!llmEntry) {
		sendError(id, 'Model not loaded: ' + modelName)
		return
	}
	if (llmEntry.type !== 'llm') {
		sendError(id, modelName + ' is not an LLM')
		return
	}

	const tokenizerEntry = models.get(tokenizerName)
	if (!tokenizerEntry || tokenizerEntry.type !== 'tokenizer') {
		sendError(id, 'Tokenizer not loaded: ' + tokenizerName)
		return
	}

	const controller = new AbortController()
	abortControllers.set(id, controller)

	try {
		const inputIds = Array.isArray(tokens) ? [tokens] : tokens
		const maxNewTokens = config?.maxNewTokens ?? 50

		let generated = [...inputIds[0]]

		for (let i = 0; i < maxNewTokens; i++) {
			if (controller.signal.aborted) {
				sendMessage(MessageType.STREAM_END, id, { reason: 'aborted' })
				return
			}

			const input = new BigInt64Array(generated.map(t => BigInt(t)))
			const output = await llmEntry.instance.generate(
				{ input_ids: new self.Tensor('int64', input, [1, generated.length]) },
				{ max_new_tokens: 1, ...config },
			)

			const outputList = output.tolist ? output.tolist() : Array.from(output.data).map(Number)
			const flat = Array.isArray(outputList[0]) ? outputList[0] : outputList
			const newToken = flat[flat.length - 1]

			generated.push(Number(newToken))

			const tokenText = tokenizerEntry.instance.decode([Number(newToken)])

			sendMessage(MessageType.STREAM_TOKEN, id, { token: Number(newToken), text: tokenText })

			const eosTokenId = tokenizerEntry.instance.model?.eos_token_id ?? tokenizerEntry.instance.eos_token_id
			if (eosTokenId !== undefined && Number(newToken) === Number(eosTokenId)) {
				break
			}
		}

		sendMessage(MessageType.STREAM_END, id, { reason: 'complete' })
	} catch (err) {
		sendError(id, err.message)
	} finally {
		abortControllers.delete(id)
	}
}

function handleAbort(data) {
	const targetId = data.generationId
	const controller = abortControllers.get(targetId)
	if (controller) {
		controller.abort()
	}
}

async function handleEmbed(id, { modelName, text }) {
	const entry = models.get(modelName)
	if (!entry) {
		sendError(id, 'Model not loaded: ' + modelName)
		return
	}
	if (entry.type !== 'embeddings') {
		sendError(id, modelName + ' is not an embeddings model')
		return
	}

	try {
		const result = await entry.instance(text, { pooling: 'mean', normalize: true })
		sendMessage(MessageType.RESULT, id, Array.from(result.data))
	} catch (err) {
		sendError(id, err.message)
	}
}

self.onmessage = async (e) => {
	const { type, id, ...params } = e.data

	switch (type) {
		case 'init':       return handleInit()
		case 'load':       return handleLoadModel(id, params)
		case 'unload':     return handleUnloadModel(id, params)
		case 'loaded':     return handleGetLoadedModels(id)
		case 'tokenize':   return handleTokenize(id, params)
		case 'detokenize': return handleDetokenize(id, params)
		case 'generate':   return handleGenerate(id, params)
		case 'abort':      return handleAbort(params)
		case 'embed':      return handleEmbed(id, params)
	}
}
