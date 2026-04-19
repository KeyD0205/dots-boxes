FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json jest.config.js ./
COPY src ./src
RUN npm install && npm run build

FROM registry.heroiclabs.com/heroiclabs/nakama:3.22.0
COPY --from=builder /app/build /nakama/data/modules/build

COPY local.yml /nakama/data/local.yml
