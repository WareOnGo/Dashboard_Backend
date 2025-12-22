#!/bin/bash

# Docker Development Helper Script

set -e

case "$1" in
  "build")
    echo "🔨 Building Docker image..."
    docker build -t warehouse-api:dev .
    ;;
  "run")
    echo "🚀 Running Docker container..."
    docker run -p 3001:3001 --env-file .env warehouse-api:dev
    ;;
  "compose-up")
    echo "🚀 Starting with Docker Compose..."
    docker-compose up --build
    ;;
  "compose-down")
    echo "🛑 Stopping Docker Compose..."
    docker-compose down
    ;;
  "shell")
    echo "🐚 Opening shell in container..."
    docker run -it --entrypoint /bin/sh warehouse-api:dev
    ;;
  "logs")
    echo "📋 Showing container logs..."
    docker-compose logs -f warehouse-api
    ;;
  "test")
    echo "🧪 Running tests in Docker..."
    docker build -t warehouse-api:test --target test .
    docker run --rm warehouse-api:test npm test
    ;;
  *)
    echo "Usage: $0 {build|run|compose-up|compose-down|shell|logs|test}"
    echo ""
    echo "Commands:"
    echo "  build        - Build Docker image"
    echo "  run          - Run container with .env file"
    echo "  compose-up   - Start with docker-compose"
    echo "  compose-down - Stop docker-compose"
    echo "  shell        - Open shell in container"
    echo "  logs         - Show container logs"
    echo "  test         - Run tests in Docker"
    exit 1
    ;;
esac