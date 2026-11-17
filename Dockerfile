FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev
COPY . .
USER node
EXPOSE 3001
CMD ["node", "index.js"]
