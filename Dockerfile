# Multi-stage build for efficient container size
FROM node:26-alpine AS builder

# Build arguments
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
ARG NODE_AUTH_TOKEN

# Set working directory
WORKDIR /app

# Copy package files (npm auth comes from the BuildKit npmrc secret provided
# by the reusable release workflow: secret-files npmrc=/tmp/.npmrc)
COPY package*.json ./

# Install dependencies (--ignore-scripts prevents 'prepare' from running before source is copied)
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --ignore-scripts

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Prune dev dependencies in builder stage (while npmrc secret is available)
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm prune --omit=dev

# Production stage
FROM node:26-alpine AS production

# Create a non-root user for security
RUN addgroup -g 1001 -S freshdesk && \
    adduser -S freshdesk -u 1001 -G freshdesk

# Set working directory
WORKDIR /app

# Copy package files and built application from builder stage
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Create logs directory
RUN mkdir -p /app/logs && chown -R freshdesk:freshdesk /app

# Switch to non-root user
USER freshdesk

# Expose port
EXPOSE 8080

# Health check against the actual HTTP endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# 0.0.0.0 is safe here only because startup refuses to listen without a real
# CONDUIT_S2S_SECRET. MCP_ALLOW_INSECURE_DEV=1 ignores this host and binds
# 127.0.0.1 only. AUTH_MODE=gateway never falls back to FRESHDESK_* env credentials.
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=gateway

# Define volume for logs
VOLUME ["/app/logs"]

# Start the application
CMD ["node", "dist/http.js"]

# Build arguments for runtime
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

# Labels for metadata
LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/freshdesk-mcp"
LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="Freshdesk MCP Server - Model Context Protocol server for the Freshdesk customer support platform"
LABEL org.opencontainers.image.title="freshdesk-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Freshdesk customer support platform integration"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/freshdesk-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/WYRE-AI/freshdesk-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/WYRE-AI/freshdesk-mcp/pkgs/container/freshdesk-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
