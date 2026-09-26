import type { CloudFrontRequestEvent, CloudFrontRequest } from 'aws-lambda'
import { parseConfig, routeRequest } from './router.js'

// Lambda@Edge does not support custom environment variables. Deployment bundles
// non-secret domains with the code. The secret stays in CloudFront origin headers.
const config = parseConfig(require('./config.json') as unknown)
export async function handler(event: CloudFrontRequestEvent): Promise<CloudFrontRequest> {
  return routeRequest(event, config)
}
