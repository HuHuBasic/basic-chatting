#!/bin/sh
# ============================================
# Basic OS 64+32-bit 双内核 — QEMU 启动脚本
# 把 ISO 文件放到手机 /sdcard/Download/ 目录
# GRUB 启动时可选 64 位或 32 位内核
# ============================================

qemu-system-x86_64 \
  -m 256M \
  -vga vmware \
  -net nic,model=e1000 \
  -net user \
  -soundhw all \
  -cdrom /sdcard/Download/basic-os-64-32.iso \
  -boot d \
  -display sdl