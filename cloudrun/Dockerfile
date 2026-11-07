# On-chain Forensics A2A server - Cloud Run image.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
