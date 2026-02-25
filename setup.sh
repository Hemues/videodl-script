#!/bin/bash

# Linux/macOS Setup Script for videodl-cli

echo "====================================="
echo "videodl-cli Setup Script"
echo "====================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check Node.js
echo -e "${BLUE}[1/3] Checking Node.js...${NC}"
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓ Node.js found: $NODE_VERSION${NC}"
    
    # Check version
    MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1 | sed 's/v//')
    if [ "$MAJOR_VERSION" -lt 18 ]; then
        echo -e "${YELLOW}⚠ Warning: Node.js 18+ recommended${NC}"
        echo -e "${YELLOW}  Current: $NODE_VERSION${NC}"
    fi
else
    echo -e "${RED}✗ Node.js not found!${NC}"
    echo -e "${YELLOW}  Install from: https://nodejs.org/${NC}"
    exit 1
fi
echo ""

# Check ffmpeg
echo -e "${BLUE}[2/3] Checking ffmpeg...${NC}"
if command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG_PATH=$(which ffmpeg)
    echo -e "${GREEN}✓ ffmpeg found: $FFMPEG_PATH${NC}"
else
    echo -e "${RED}✗ ffmpeg not found!${NC}"
    echo ""
    
    # Detect OS and suggest installation
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo -e "${YELLOW}Install ffmpeg:${NC}"
        if command -v apt-get >/dev/null 2>&1; then
            echo "  sudo apt update && sudo apt install ffmpeg"
        elif command -v dnf >/dev/null 2>&1; then
            echo "  sudo dnf install ffmpeg"
        elif command -v pacman >/dev/null 2>&1; then
            echo "  sudo pacman -S ffmpeg"
        else
            echo "  Use your package manager to install ffmpeg"
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        echo -e "${YELLOW}Install ffmpeg:${NC}"
        if command -v brew >/dev/null 2>&1; then
            echo "  brew install ffmpeg"
        else
            echo "  Install Homebrew first: https://brew.sh/"
            echo "  Then: brew install ffmpeg"
        fi
    fi
    
    echo ""
    read -p "Install ffmpeg now? (y/N) " -n 1 -r
    echo ""
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            if command -v apt-get >/dev/null 2>&1; then
                sudo apt update && sudo apt install -y ffmpeg
            elif command -v dnf >/dev/null 2>&1; then
                sudo dnf install -y ffmpeg
            elif command -v pacman >/dev/null 2>&1; then
                sudo pacman -S --noconfirm ffmpeg
            fi
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            if command -v brew >/dev/null 2>&1; then
                brew install ffmpeg
            fi
        fi
        
        # Verify installation
        if command -v ffmpeg >/dev/null 2>&1; then
            echo -e "${GREEN}✓ ffmpeg installed!${NC}"
        else
            echo -e "${RED}✗ Installation failed${NC}"
            echo -e "${YELLOW}  Please install manually and run this script again${NC}"
            exit 1
        fi
    else
        echo -e "${YELLOW}⚠ Skipping ffmpeg installation${NC}"
        echo -e "${YELLOW}  Note: videodl-cli requires ffmpeg to function${NC}"
    fi
fi
echo ""

# Install npm dependencies
echo -e "${BLUE}[3/3] Installing dependencies...${NC}"
if npm install; then
    echo -e "${GREEN}✓ Dependencies installed!${NC}"
else
    echo -e "${RED}✗ Failed to install dependencies${NC}"
    exit 1
fi
echo ""

# Global installation
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo -e "${YELLOW}Install videodl globally? (Y/n)${NC}"
echo -e "  ${NC}This allows you to run 'videodl' from anywhere${NC}"
read -r GLOBAL

if [ -z "$GLOBAL" ] || [ "$GLOBAL" = "Y" ] || [ "$GLOBAL" = "y" ]; then
    echo -e "${BLUE}Installing globally...${NC}"
    if npm link; then
        echo -e "${GREEN}✓ Global installation complete!${NC}"
        echo ""
        echo -e "${BLUE}You can now use 'videodl' from anywhere:${NC}"
        echo "  videodl --version"
        echo "  videodl info"
        echo "  videodl download <url>"
    else
        echo -e "${YELLOW}⚠ Global installation failed${NC}"
        echo -e "  ${NC}Try: sudo npm link${NC}"
        echo -e "  ${NC}Or use: node src/cli.js <command>${NC}"
    fi
else
    echo -e "${NC}Skipping global installation${NC}"
    echo "Use: node src/cli.js <command>"
fi

echo ""
echo "====================================="
echo -e "${BLUE}Next steps:${NC}"
echo "  1. Test: videodl info"
echo "  2. Read: README.md"
echo "  3. Examples: node examples.js"
echo "====================================="
