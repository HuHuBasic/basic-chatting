#!/bin/sh
# Basic OS 64+32-bit 双内核 QEMU 配置文件
# 使用方法：在 Qemu启动器 中选择此文件
# GRUB 启动菜单可选 64 位或 32 位内核

# CPU 架构
ARCH=x86_64

# 内存 (MB)
RAM=256

# CPU 核心数
CPU_CORES=1

# 显卡
VGA=vmware

# 网卡
NET_CARD=e1000

# 网络模式
NET_MODE=user

# 声卡
SOUND_CARD=all

# 图形界面
DISPLAY=sdl

# 光盘镜像路径 (请修改为你的实际路径)
CDROM=/storage/emulated/0/Download/basic-os-64-32.iso

# 启动方式: cdrom
BOOT_MODE=cdrom

# 额外参数 (留空)
EXTRA_PARAMS=