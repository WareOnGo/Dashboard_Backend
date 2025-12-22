# Docker & AWS ECR Deployment Guide

This guide covers how to containerize the Warehouse API and deploy it to AWS ECR.

## Prerequisites

1. **Docker** - Install Docker Desktop
2. **AWS CLI** - Install and configure with your credentials
3. **AWS Account** - With ECR permissions

## Local Development with Docker

### Quick Start

```bash
# Build and run with Docker Compose
npm run docker:up

# Stop the containers
npm run docker:down
```

### Manual Docker Commands

```bash
# Build the image
npm run docker:build

# Run the container
npm run docker:run

# View logs
npm run docker:logs
```

### Environment Setup

1. Copy the example environment file:
   ```bash
   cp .env.docker.example .env
   ```

2. Update `.env` with your actual values:
   - Database connection string
   - AWS credentials
   - Other environment variables

## AWS ECR Deployment

### Method 1: Using the Deployment Script

```bash
# Deploy to ECR (uses defaults: us-east-1, warehouse-api, latest)
npm run deploy:ecr

# Deploy with custom parameters
./scripts/deploy-ecr.sh us-west-2 my-warehouse-api v1.0.0
```

### Method 2: Manual Steps

1. **Create ECR Repository**:
   ```bash
   aws ecr create-repository --repository-name warehouse-api --region us-east-1
   ```

2. **Get Login Token**:
   ```bash
   aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com
   ```

3. **Build and Tag**:
   ```bash
   docker build -t warehouse-api .
   docker tag warehouse-api:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/warehouse-api:latest
   ```

4. **Push to ECR**:
   ```bash
   docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/warehouse-api:latest
   ```

### Method 3: GitHub Actions (Automated)

The repository includes a GitHub Actions workflow that automatically builds and pushes to ECR on:
- Push to `main` branch
- New version tags
- Manual workflow dispatch

**Setup GitHub Secrets**:
1. Go to your repository Settings → Secrets and variables → Actions
2. Add these secrets:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`

## Using the ECR Image

### ECS Task Definition Example

```json
{
  "family": "warehouse-api",
  "taskRoleArn": "arn:aws:iam::account:role/ecsTaskRole",
  "executionRoleArn": "arn:aws:iam::account:role/ecsTaskExecutionRole",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    {
      "name": "warehouse-api",
      "image": "<account-id>.dkr.ecr.us-east-1.amazonaws.com/warehouse-api:latest",
      "portMappings": [
        {
          "containerPort": 3001,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        },
        {
          "name": "PORT",
          "value": "3001"
        }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:database-url"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/warehouse-api",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

### EKS Deployment Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: warehouse-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: warehouse-api
  template:
    metadata:
      labels:
        app: warehouse-api
    spec:
      containers:
      - name: warehouse-api
        image: <account-id>.dkr.ecr.us-east-1.amazonaws.com/warehouse-api:latest
        ports:
        - containerPort: 3001
        env:
        - name: NODE_ENV
          value: "production"
        - name: PORT
          value: "3001"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: database-secret
              key: url
---
apiVersion: v1
kind: Service
metadata:
  name: warehouse-api-service
spec:
  selector:
    app: warehouse-api
  ports:
  - port: 80
    targetPort: 3001
  type: LoadBalancer
```

## Troubleshooting

### Common Issues

1. **Docker build fails**:
   - Check if all dependencies are in package.json
   - Ensure .dockerignore excludes node_modules

2. **ECR push fails**:
   - Verify AWS credentials: `aws sts get-caller-identity`
   - Check ECR permissions
   - Ensure you're logged in to ECR

3. **Container won't start**:
   - Check environment variables
   - Verify database connectivity
   - Check container logs: `docker logs <container-id>`

### Health Checks

The application includes a health endpoint at `/health` that checks:
- API status
- Database connectivity

Use this for container health checks and load balancer targets.

## Security Best Practices

1. **Use non-root user** - The Dockerfile creates and uses a `nodejs` user
2. **Minimal base image** - Uses `node:20-alpine` for smaller attack surface
3. **Environment secrets** - Use AWS Secrets Manager or Parameter Store
4. **Network security** - Configure VPC and security groups appropriately
5. **Image scanning** - Enable ECR vulnerability scanning

## Monitoring and Logging

- Configure CloudWatch logs for container output
- Set up CloudWatch metrics for container performance
- Use AWS X-Ray for distributed tracing
- Monitor ECR for image vulnerabilities