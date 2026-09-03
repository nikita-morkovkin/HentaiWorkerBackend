FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src/

RUN npm run build

RUN npm prune --production

FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache ffmpeg ffmpeg-libs font-noto ttf-dejavu fontconfig freetype

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/package.json ./package.json

RUN mkdir -p /app/uploads/covers && chown -R node:node /app/uploads

USER node

EXPOSE 4000

CMD ["sh", "-c", "npx prisma db push && node dist/main"]
