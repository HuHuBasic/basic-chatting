#!/bin/sh
# ============================================
# Basic OS 32-bit — QEMU 启动脚本
# 把 ISO 文件放到手机 /sdcard/Download/ 目录
# ============================================

qemu-system-i386 \
  -m 128M \
  -vga vmware \
  -net nic,model=e1000 \
  -net user \
  -soundhw all \
  -cdrom /sdcard/Download/basic-os-32.iso \
  -boot d \
  -display sdl