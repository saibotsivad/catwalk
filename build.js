import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const main = readFileSync(join('src', 'main.js'), 'utf8')
const worker = readFileSync(join('src', 'worker.js'), 'utf8')

mkdirSync('dist', { recursive: true })

writeFileSync(
	join('dist', 'main.js'),
	main
		.replace(
			`'$$$TEMPLATE:package.json:version$$$'`,
			JSON.stringify(version),
		)
		.replace(
			`'$$$TEMPLATE:worker.js$$$'`,
			JSON.stringify(worker),
		),
	'utf8',
)
