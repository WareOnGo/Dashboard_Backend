# Complete Setup Guide for Docker & AWS ECR Deployment

## Step 1: Install Docker

### On Ubuntu/Debian:
```bash
# Update package index
sudo apt update

# Install required packages
sudo apt install apt-transport-https ca-certificates curl software-properties-common

# Add Docker's official GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

# Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Update package index again
sudo apt update

# Install Docker
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add your user to docker group (to run without sudo)
sudo usermod -aG docker $USER

# Log out and back in, or run:
newgrp docker

# Test Docker installation
docker --version
docker run hello-world
```

### On macOS:
```bash
# Install Docker Desktop from https://www.docker.com/products/docker-desktop
# Or using Homebrew:
brew install --cask docker
```

### On Windows:
Download and install Docker Desktop from https://www.docker.com/products/docker-desktop

## Step 2: Install AWS CLI

### On Linux:
```bash
# Download AWS CLI
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"

# Unzip
unzip awscliv2.zip

# Install
sudo ./aws/install

# Verify installation
aws --version
```

### On macOS:
```bash
# Using Homebrew
brew install awscli

# Or download installer from AWS
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /
```

### On Windows:
Download and install from: https://aws.amazon.com/cli/

## Step 3: Configure AWS CLI

```bash
# Configure AWS credentials
aws configure

# You'll be prompted for:
# AWS Access Key ID: [Your access key]
# AWS Secret Access Key: [Your secret key]
# Default region name: [e.g., us-east-1]
# Default output format: [json]

# Test configuration
aws sts get-caller-identity
```

## Step 4: Create AWS ECR Repository

```bash
# Create ECR repository
aws ecr create-repository --repository-name warehouse-api --region us-east-1

# Note the repository URI from the output
```

## Step 5: Test Docker Build

```bash
# Navigate to your project directory
cd /path/to/your/warehouse-api

# Build Docker image
docker build -t warehouse-api:latest .

# Test run locally (make sure you have .env file)
docker run -p 3001:3001 --env-file .env warehouse-api:latest
```

## Step 6: Deploy to ECR

```bash
# Make the script executable
chmod +x scripts/deploy-ecr.sh

# Deploy to ECR
./scripts/deploy-ecr.sh us-east-1 warehouse-api latest
```

## Step 7: Set up GitHub Actions (Optional)

1. Go to your GitHub repository
2. Navigate to Settings → Secrets and variables → Actions
3. Add these repository secrets:
   - `AWS_ACCESS_KEY_ID`: Your AWS access key
   - `AWS_SECRET_ACCESS_KEY`: Your AWS secret key

4. Push your code to trigger the workflow:
```bash
git add .
git commit -m "Add Docker and ECR deployment setup"
git push origin main
```

## Step 8: Use the ECR Image

### Option A: AWS ECS (Recommended for production)

1. Create an ECS cluster
2. Create a task definition using your ECR image
3. Create a service to run the task
4. Configure load balancer and auto-scaling

### Option B: AWS EKS (For Kubernetes)

1. Create an EKS cluster
2. Apply Kubernetes manifests using your ECR image
3. Configure ingress and services

### Option C: AWS Lambda (For serverless)

1. Create a Lambda function from container image
2. Use your ECR image URI
3. Configure environment variables and triggers

## Troubleshooting

### Docker Issues:
```bash
# Check Docker status
sudo systemctl status docker

# Start Docker if not running
sudo systemctl start docker

# Check Docker permissions
docker run hello-world
```

### AWS CLI Issues:
```bash
# Check AWS configuration
aws configure list

# Test AWS connectivity
aws sts get-caller-identity

# Check ECR permissions
aws ecr describe-repositories
```

### Build Issues:
```bash
# Check Dockerfile syntax
docker build --no-cache -t warehouse-api:debug .

# Run with verbose output
docker build --progress=plain -t warehouse-api:debug .
```

## Next Steps

1. **Set up monitoring**: Configure CloudWatch logs and metrics
2. **Security**: Use AWS Secrets Manager for sensitive data
3. **CI/CD**: Enhance GitHub Actions with testing and staging
4. **Scaling**: Configure auto-scaling based on metrics
5. **Backup**: Set up database backups and disaster recovery

## Useful Commands

```bash
# Docker commands
docker images                    # List images
docker ps                       # List running containers
docker logs <container-id>      # View container logs
docker exec -it <container-id> /bin/sh  # Shell into container

# AWS ECR commands
aws ecr describe-repositories   # List ECR repositories
aws ecr list-images --repository-name warehouse-api  # List images in repo
aws ecr batch-delete-image --repository-name warehouse-api --image-ids imageTag=old-tag  # Delete image

# Cleanup commands
docker system prune -a          # Remove unused Docker resources
docker image prune              # Remove unused images
```