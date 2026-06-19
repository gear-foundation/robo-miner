FROM node:22-alpine AS build

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps \
 && npm cache clean --force

FROM node:22-alpine AS run

ENV NODE_ENV=production

WORKDIR /app/backend

COPY --from=build --chown=node:node /app/node_modules /app/backend/node_modules
COPY --chown=node:node backend/package.json /app/backend/package.json
COPY --chown=node:node backend/src /app/backend/src
COPY --chown=node:node backend/docker-entrypoint.sh /app/backend/docker-entrypoint.sh
COPY --chown=node:node frontend/src /app/frontend/src

COPY --chown=node:node frontend/src/chain/world.idl          /app/contracts/target/wasm32-gear/release/digger_world.idl
COPY --chown=node:node backend/src/chain/digger_proxy.idl    /app/contracts/target/wasm32-gear/release/digger_proxy.idl
COPY --chown=node:node frontend/src/chain/digger_res_vmt.idl /app/contracts/target/wasm32-gear/release/digger_res_vmt.idl
COPY --chown=node:node frontend/src/chain/digger_redeem.idl  /app/contracts/target/wasm32-gear/release/digger_redeem.idl

RUN chmod +x /app/backend/docker-entrypoint.sh

USER node

CMD ["./docker-entrypoint.sh"]
