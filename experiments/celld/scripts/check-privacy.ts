import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Inspect exactly the prospective public repository content, including new files;
// never read ignored deployment artifacts or secret caches.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const forbidden = [
  /\b\d{12}\b/, // Actual AWS account IDs; ${AWS::AccountId} remains valid.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:LAB_TOKEN|ORIGIN_SECRET)\s*[=:]\s*["']?[a-f0-9]{64}\b/,
  /\b[a-z0-9]{13,}\.cloudfront\.net\b/, // Issued distribution host, not example placeholders.
  /\bi-[a-f0-9]{8,17}\b/, // Literal EC2 instance identifier.
  /\b[a-z0-9-]+-\d{6,}\.[a-z]{2}(?:-[a-z]+)+-\d+\.elb\.amazonaws\.com\b/,
]
let failures = 0
for (const file of files) {
  let source: string
  try { source = readFileSync(file, 'utf8') } catch { continue /* Deleted tracked file. */ }
  for (const [index, line] of source.split('\n').entries()) {
    if (forbidden.some(pattern => pattern.test(line))) {
      // Never print the matched secret/account information itself.
      console.error(`Potential private deployment information: ${file}:${index + 1}`)
      failures++
    }
  }
}
if (failures) throw new Error('Privacy check failed; inspect locally before publishing')
console.log('PASS: prospective public files contain no literal AWS account/access-key/instance IDs, issued CloudFront/ALB hosts, private keys, or literal lab/origin secrets. Other resource-name review is still required.')
