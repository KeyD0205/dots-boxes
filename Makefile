.PHONY: up down logs client-build nakama-build test

up:
	docker compose up --build

down:
	docker compose down -v

logs:
	docker compose logs -f

client-build:
	cd client && npm install && npm run build

nakama-build:
	cd nakama && npm install && npm run build

test:
	cd nakama && npm install && npm test
