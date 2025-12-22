#!/bin/bash

# AWS ECR Deployment Script
# Usage: ./scripts/deploy-ecr.sh [AWS_REGION] [ECR_REPOSITORY_NAME] [IMAGE_TAG]

set -e

# Default values
AWS_REGION=${1:-us-east-1}
ECR_REPOSITORY_NAME=${2:-warehouse-api}
IMAGE_TAG=${3:-latest}

echo "🚀 Starting AWS ECR deployment..."
echo "📍 Region: $AWS_REGION"
echo "📦 Repository: $ECR_REPOSITORY_NAME"
echo "🏷️  Tag: $IMAGE_TAG"

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed. Please install it first."
    exit 1
fi

# Check if Docker is running
if ! docker info &> /dev/null; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Get AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$AWS_ACCOUNT_ID" ]; then
    echo "❌ Failed to get AWS account ID. Please check your AWS credentials."
    exit 1
fi

echo "🔑 AWS Account ID: $AWS_ACCOUNT_ID"

# ECR repository URI
ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY_NAME"

echo "📋 ECR URI: $ECR_URI"

# Create ECR repository if it doesn't exist
echo "🏗️  Creating ECR repository (if it doesn't exist)..."
aws ecr describe-repositories --repository-names $ECR_REPOSITORY_NAME --region $AWS_REGION &> /dev/null || \
aws ecr create-repository --repository-name $ECR_REPOSITORY_NAME --region $AWS_REGION

# Get login token and login to ECR
echo "🔐 Logging in to ECR..."
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_URI

# Build the Docker image
echo "🔨 Building Docker image..."
docker build -t $ECR_REPOSITORY_NAME:$IMAGE_TAG .

# Tag the image for ECR
echo "🏷️  Tagging image for ECR..."
docker tag $ECR_REPOSITORY_NAME:$IMAGE_TAG $ECR_URI:$IMAGE_TAG

# Push the image to ECR
echo "📤 Pushing image to ECR..."
docker push $ECR_URI:$IMAGE_TAG

echo "✅ Successfully deployed to ECR!"
echo "📍 Image URI: $ECR_URI:$IMAGE_TAG"
echo ""
echo "🚀 You can now use this image in your AWS services (ECS, EKS, Lambda, etc.)"
echo "💡 Example ECS task definition image: $ECR_URI:$IMAGE_TAG"