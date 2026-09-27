# syntax=docker/dockerfile:1
# The same HTTP server runs locally and inside Lambda via the Web Adapter.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=node_auth_token,env=NODE_AUTH_TOKEN,required=true npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 \
    AWS_LWA_PORT=8080 AWS_LWA_READINESS_CHECK_PATH=/readyz \
    AWS_LWA_READINESS_CHECK_HEALTHY_STATUS=200 AWS_LWA_INVOKE_MODE=buffered
COPY --from=build --chown=node:node /app/.output ./.output
USER node
EXPOSE 8080
CMD ["node", ".output/server/index.mjs"]
