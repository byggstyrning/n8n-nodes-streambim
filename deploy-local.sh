#!/bin/bash
# Build n8n-nodes-streambim and deploy to local n8n (Docker) custom nodes folder.
#
# The target directory is fully replaced (rm -rf) so old node files are not left behind.
# If you still see multiple StreamBIM entries in the node palette, remove any other
# custom packages that register StreamBIM nodes and restart n8n.
#
# Usage: ./deploy-local.sh

set -e

PACKAGE_NAME=$(node -p "require('./package.json').name")

if [ -z "$PACKAGE_NAME" ]; then
	echo "Error: Could not determine package name from package.json."
	exit 1
fi

SOURCE_DIR="./dist"
# Local n8n with StreamBIM custom nodes: ifcpipeline stack (formerly ifcpipeline-objectstorage).
TARGET_DIR="../ifcpipeline/n8n-data/custom/$PACKAGE_NAME"
DOCKER_COMPOSE_DIR="../ifcpipeline"

echo "========================================"
echo "Deploying StreamBIM n8n nodes (local)"
echo "========================================"
echo "Package name: '$PACKAGE_NAME'"
echo "Source directory: '$SOURCE_DIR'"
echo "Target directory: '$TARGET_DIR'"
echo ""

echo "Building..."
rm -rf dist
pnpm run build

if [ ! -d "$SOURCE_DIR" ]; then
	echo "Error: Build directory '$SOURCE_DIR' not found."
	exit 1
fi

echo "✓ Build complete."
echo ""

echo "Deploying to n8n custom nodes directory..."

if [ -d "$TARGET_DIR" ]; then
	rm -rf "$TARGET_DIR"
	echo "  - Removed previous deployment"
fi

mkdir -p "$TARGET_DIR"
cp package.json "$TARGET_DIR/"
# Package.json paths are dist/credentials/..., dist/nodes/... — keep a dist/ directory
cp -r "$SOURCE_DIR" "$TARGET_DIR/dist"

echo "✓ Deployment complete."
echo ""

echo "Restarting n8n container..."
cd "$DOCKER_COMPOSE_DIR"
docker compose restart n8n

echo ""
echo "========================================"
echo "✓ Deployment successful!"
echo "========================================"
echo ""
echo "Next steps:"
echo "  1. Wait ~10-15 seconds for n8n to restart"
echo "  2. Open n8n (often http://localhost:5678)"
echo "  3. StreamBIM nodes should appear under community/custom nodes"
echo ""
echo "Logs: (from $DOCKER_COMPOSE_DIR) docker compose logs -f n8n"
echo ""
