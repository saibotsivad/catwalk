# Catwalk
=========

Models run inside a Web Worker so they are non blocking.

## 1. Capabilities
------------------

The class exposes three foundational AI capabilities:

- tokenization
- text generation
- embeddings

Models are downloaded from HuggingFace, cached by the browser, and tracked in an IndexedDB registry that persists across page reloads.

## 2. Goals
-----------

**Expose raw primitives.** Intentionally low-level. It gives you tokens, not chat. Vectors, not "similar documents." Generation streams, not formatted responses. The idea is to make the foundational pieces of modern AI tangible and individually observable — what a tokenizer actually does, what a language model actually produces, what an embedding vector actually looks like.

**Stay off the main thread.** Everything heavy runs inside a Web Worker. The main thread only sends messages and receives results. Model weights, runtimes, and inference loops never touch the UI thread.

**Explicit lifecycle.** Models must be loaded before use and can be unloaded when done. If you call `tokenize` with a model that isn't loaded, you get an error instead of a silent download. You control what's in memory and when.

**Single file, no build step.** The entire implementation lives in one JavaScript module. The Worker code is embedded as a template literal and instantiated via a blob URL. Import the file and go.

## 3. Architecture
------------------

The main thread and Worker thread communicate with a simple RPC-like `postMessage` pattern: each message carries a `type` (the operation) and an `id` that correlates the response back to the right promise/stream.

Catwalk has an internal state representing the Promises in-flight and the model registry state, e.g. which models are cached and/or loaded.

Caching the models happens in IndexedDB.

## 4. Example Usage
-------------------

Add it as a script to your page:

```html
<script src="https://saibotsivad.github.io/golem/lib/catwalk.js">
```

Then you can use `Catwalk` as a global variable, like this:

```js
// Monitor progress of model download/setup:
Catwalk.onProgress(({ modelName, modelType, status, percent, file }) => {
	console.log(`Model ${modelName} status is: ${status}`)
})
// Load a tokenizer (downloads on first call, cached after):
Catwalk.loadModel(Catwalk.ModelType.TOKENIZER, 'Xenova/gpt2').then(() => {
	console.log('Model loaded!')
})
```

## 5. Model Management
----------------------

Catwalk exposes the following functions:

### loadModel

```ts
function loadModel(type: ModelType, model: string): Promise<void>
```

Loading a model downloads on the first call, retrieves from cache afterward. For example:

```js
await Catwalk.loadModel(Catwalk.ModelType.TOKENIZER, 'Xenova/gpt2')
```

### onProgress

```ts
function onProgress(cb: ({ modelName, modelType, status, percent, file }) => void): void
```

Register a progress function which is called any time the status of the model changes.

### getLoadedModels

```ts
function getLoadedModels(): Promise<Model[]>
```

See what's currently loaded in the Worker:

```js
const loaded = await Catwalk.getLoadedModels()
// => [ { name: 'Xenova/gpt2', type: 'tokenizer' }, ... ]
```

```ts
interface Model {
	// The name as it's provided for Transformers.js, e.g. "Xenova/gpt2"
	name: string
	// Enum available as `Catwalk.ModelType.<TYPE>`
	type: 'EMBEDDING' | 'LM' | 'TOKENIZER'
}
```

### isModelCached

```ts
function isModelCached (name: string): Promise<boolean>
```

Check if a model has been previously downloaded and is in the cache.

```js
Catwalk.isModelCached('Xenova/gpt2')
// => true
```

### unloadModel

```ts
function unloadModel (name: string): Promise<void>
```

Release a model from Worker memory, leaving in browser cache.

```js
await Catwalk.unloadModel('Xenova/gpt2')
```

### uncacheModel

```ts
function uncacheModel (name: string): Promise<void>
```

Clear a model from the browser cache.

```js
await Catwalk.uncacheModel('Xenova/gpt2')
```

## 6. Tokenization
------------------

Turning text strings into arrays of float values, and vice versa.

Load a tokenizer (downloads on first call, cached after):

```js
await Catwalk.loadModel(Catwalk.ModelType.TOKENIZER, 'Xenova/gpt2')
```

### tokenize

```ts
function tokenize(model: string, message: string, configs?: unknown): Promise<number[]>
```

The `configs` object will be passed to Transformers.js as-is.

Generate tokens from a string:

```js
const tokens = await Catwalk.tokenize('Xenova/gpt2', 'The cat sat on the mat')
// => [464, 3797, 3332, 319, 262, 2603]
```

### detokenize

```ts
function detokenize(model: string, tokens: numbers[], configs?: unknown): Promise<string>
```

The `configs` object will be passed to Transformers.js as-is.

Or generate a string from some tokens:

```js
const text = await Catwalk.detokenize('Xenova/gpt2', tokens)
// => 'The cat sat on the mat'
```

Even a larger seems to be fast enough to not need to interrupt it, so there are no additional controls.

## 7. Text Generation
---------------------

For a given array of tokens, generate additional tokens.

Load the LLM (this can be a big download):

```js
await Catwalk.loadModel(Catwalk.ModelType.LLM, 'Xenova/gpt2')
```

### generate

```ts
function generate(
	model: string,
	tokenizer: string,
	tokens: number[],
	config?: GenerateConfig,
): AsyncIterable<GenerateResult>

interface GenerateResult {
	token: number
	text: string
}
```

Stream generated tokens as an async iterator. You have to tokenize the text first, but the output will be the generated token as well as the detokenized text, for convenience.

Each iteration yields an object with `token` (the numeric ID) and `text` (the decoded string for that token). The iterator completes when the model emits an end-of-sequence token or hits `maxNewTokens`.

```js
const tokens = await Catwalk.tokenize('Xenova/gpt2', 'Once upon a time')
for await (const { token, text } of Catwalk.generate(
	'Xenova/gpt2',        // LM model name
	'Xenova/gpt2',        // tokenizer model name
	tokens,               // input token IDs
	{ maxNewTokens: 30 }, // config
)) {
	// Do something with the token or the text
	console.log(token, text)
}
```

Text generation does support interruption:

```js
// TODO to abort you would send an abort controller signal
```

## 8. Embeddings
----------------

Embeddings are arrays of numbers generated from strings.

You'll likely want some vector storage or something, but note that Catwalk does not cache or store these, or generate cosine similarity, etc.

### embed

```ts
function embed(model: string, message: string): Promise<number[]>
```

The returned vector is a plain JavaScript array of floats, exactly what would come out of the Transformers.js call.

Generate an embedding for a string (you need to load the embedding model first):

```js
await Catwalk.loadModel(Catwalk.ModelType.EMBEDDING, 'Xenova/all-MiniLM-L6-v2')

const vector = await Catwalk.embed('Xenova/all-MiniLM-L6-v2', 'A sentence about dogs')
// => [0.012, -0.045, 0.098, ...] (384-dimensional float array)
```

## 9. Known Issues
------------------

**Abort ergonomics.** The `generate` async iterator uses an internal UUID for its generation session, but the current `abort()` method requires that ID. Since the ID isn't exposed to the caller, abort isn't easily wired up yet. A future revision should either return the ID alongside the iterator or add a method like `abortAll()`.

**Loading indicators.** There's not functionality to support a loading indicator yet, but it's planned.

**Model file cache is separate.** Catwalk's `clearCache` only clears its own registry. The actual model weight files are cached by Transformers.js (via the browser Cache API). To fully purge downloaded models, you'd need to clear that cache separately.

**Generation loop.** The Worker-side generation uses a token-by-token loop that may not be the most efficient approach for all model architectures. The Transformers.js `generate` API is evolving — this inner loop is the most likely thing to need adjustment.

**Blob URL + module imports.** The Worker is created from a blob URL with `type: 'module'`, importing Transformers.js from a CDN. This works in modern browsers but may hit CORS issues in some environments. Falling back to `importScripts()` with the UMD build is possible but requires dropping ES module syntax in the Worker code.
