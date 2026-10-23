FROM node:22-alpine AS build

WORKDIR /app
COPY package.json ./
COPY src/ src/
COPY bin/ bin/

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"

EXPOSE 8080
CMD ["node", "src/server.js"]
