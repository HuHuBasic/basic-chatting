FROM node:20-alpine
WORKDIR /app
RUN mkdir -p /data
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 8080
ENV PORT=8080
VOLUME ["/data"]
CMD ["node", "server.js"]