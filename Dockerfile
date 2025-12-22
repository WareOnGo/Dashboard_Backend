FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["node", "index.js"]