# Node 20 (small image)
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --production --legacy-peer-deps
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["npm","start"]
