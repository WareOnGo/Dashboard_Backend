#!/bin/bash

# CI Test Script
# This script simulates what GitHub Actions will run

echo "🚀 Starting CI Test Pipeline..."

echo "📦 Installing dependencies..."
npm ci

echo "🧪 Running tests..."
npm test

echo "📊 Running tests with coverage..."
npm test -- --coverage

echo "✅ CI Test Pipeline completed successfully!"