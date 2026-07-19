#!/bin/bash
# ============================================================
#  Basic Chatting - 安装包制作脚本
#  生成 .bak 自解压安装包
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_NAME="Basic-Chatting-v1.0.bak"
TMP_DIR="/tmp/bc-pkg"

echo ">>> 打包 Basic Chatting 安装包..."

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

# 复制应用文件
cp "$SCRIPT_DIR/server.js" "$TMP_DIR/"
cp "$SCRIPT_DIR/package.json" "$TMP_DIR/"
cp "$SCRIPT_DIR/basic-chatting.html" "$TMP_DIR/"
cp "$SCRIPT_DIR/index.html" "$TMP_DIR/"
cp "$SCRIPT_DIR/.gitignore" "$TMP_DIR/" 2>/dev/null

# 包信息
cat > "$TMP_DIR/package.info" << 'EOF'
name=Basic-Chatting
version=1.0
type=web-app
date=$(date '+%Y-%m-%d')
description=跨设备实时聊天平台，支持头像/朋友圈/群聊/账号管理
requires=nodejs
ports=8080
EOF
sed -i "s/\$(date '+%Y-%m-%d')/$(date '+%Y-%m-%d')/" "$TMP_DIR/package.info"

# 安装器入口
cat > "$TMP_DIR/install.sh" << 'ENTRYEOF'
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  Basic Chatting v1.0 - 安装器"
echo "  跨设备实时聊天平台"
echo "============================================"
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "[错误] 需要安装 Node.js"
    echo "  Ubuntu/Debian: sudo apt install nodejs npm"
    echo "  macOS: brew install node"
    echo "  或访问 https://nodejs.org 下载安装"
    exit 1
fi

echo "Node.js 版本: $(node -v)"
echo ""

echo "1) 安装依赖并启动 (端口 8080)"
echo "2) 仅安装依赖"
echo "3) 启动服务器"
echo "4) 退出"
echo ""
read -p "请选择 [1-4]: " choice

case "$choice" in
    1)
        echo ">>> 安装依赖..."
        cd "$SCRIPT_DIR" && npm install
        echo ">>> 启动服务器..."
        echo ""
        echo "  官网:     http://localhost:8080"
        echo "  聊天应用: http://localhost:8080/chat"
        echo ""
        node server.js
        ;;
    2)
        echo ">>> 安装依赖..."
        cd "$SCRIPT_DIR" && npm install
        echo "依赖安装完成!"
        ;;
    3)
        echo ">>> 启动服务器..."
        echo ""
        echo "  官网:     http://localhost:8080"
        echo "  聊天应用: http://localhost:8080/chat"
        echo ""
        cd "$SCRIPT_DIR" && node server.js
        ;;
    4)
        echo "再见!"
        exit 0
        ;;
    *)
        echo "无效选项"
        ;;
esac
ENTRYEOF
chmod +x "$TMP_DIR/install.sh"

# 打包
cd "$TMP_DIR"
tar -czf "/tmp/bc-payload.tar.gz" .
cd "$SCRIPT_DIR"

# 生成自解压 .bak
cat > "$OUT_NAME" << 'BAKHEAD'
#!/bin/bash
# ============================================================
#  Basic Chatting 安装包 (.bak)
#  运行: bash Basic-Chatting-v1.0.bak
# ============================================================
echo "============================================"
echo "  Basic Chatting v1.0 - 安装包"
echo "  正在解压..."
echo "============================================"

TMPDIR=$(mktemp -d)
ARCHIVE=$(awk '/^__ARCHIVE__$/ {print NR+1; exit}' "$0")
tail -n +$ARCHIVE "$0" | tar -xz -C "$TMPDIR"

echo "解压完成: $TMPDIR"
echo ""
cd "$TMPDIR" && bash install.sh

rm -rf "$TMPDIR"
exit 0
__ARCHIVE__
BAKHEAD

cat "/tmp/bc-payload.tar.gz" >> "$OUT_NAME"
chmod +x "$OUT_NAME"

rm -rf "$TMPDIR" "/tmp/bc-payload.tar.gz"

echo ""
echo "✓ 安装包生成完成!"
echo "  文件: $(pwd)/$OUT_NAME"
echo "  大小: $(ls -lh "$OUT_NAME" | awk '{print $5}')"
echo ""
echo "  使用方式:"
echo "  bash $OUT_NAME"