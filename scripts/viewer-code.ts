import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

/** Package the strictly typechecked, standalone handler for CloudFront JS 2.0. */
export function viewerCode(): string {
  const source = readFileSync(new URL('../viewer/handler.ts', import.meta.url), 'utf8')
  return "import cf from 'cloudfront';\n" + stripTypeScriptTypes(source, { mode: 'strip' })
}
