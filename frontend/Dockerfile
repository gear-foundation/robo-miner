FROM node:20-alpine

WORKDIR /app

ARG VITE_NODE_ADDRESS=wss://rpc.vara.network
ARG VITE_PROGRAM_ID=0xacc90a11efbb848c75cfd166b00c4bf3d702fd767f0930e9d2840bf091614f1b
ARG VITE_VOUCHER_BACKEND_URL=https://arcade-vara-production.up.railway.app

ENV VITE_NODE_ADDRESS=$VITE_NODE_ADDRESS
ENV VITE_PROGRAM_ID=$VITE_PROGRAM_ID
ENV VITE_VOUCHER_BACKEND_URL=$VITE_VOUCHER_BACKEND_URL

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

EXPOSE 5173

CMD ["sh", "-c", "npm run preview -- --host 0.0.0.0 --port ${PORT:-5173}"]
