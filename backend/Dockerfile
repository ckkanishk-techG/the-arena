FROM node:22-alpine
WORKDIR /app/backend
RUN apk add --no-cache openssl libc6-compat
COPY backend/package.json ./package.json
RUN npm install
COPY backend/ ./
COPY index.html /app/index.html
RUN npx prisma generate && npm run build
EXPOSE 4000
CMD ["sh", "-c", "npx prisma db push && node dist/src/server.js"]