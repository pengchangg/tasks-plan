#!/bin/sh
# 本地出 APK。工具链默认在 ~/.local/android-toolchain（来源见 README「墙内网络」）。
# 4 GB 机器上 Gradle 吃 2 GB 会和别的构建打架，这里压到 1.5 GB。
set -eu
TC=${GROWJOY_ANDROID_TOOLCHAIN:-$HOME/.local/android-toolchain}
GRADLE="$TC/gradle-8.9/bin/gradle"
JDK=$(ls -d "$TC"/jdk-* 2>/dev/null | head -1)
[ -x "$GRADLE" ] && [ -n "$JDK" ] || { echo "工具链缺失：$TC（见 README）" >&2; exit 1; }

cd "$(dirname "$0")"
echo "sdk.dir=$TC/sdk" > local.properties
JAVA_HOME="$JDK" ANDROID_HOME="$TC/sdk" PATH="$JDK/bin:$PATH" \
  "$GRADLE" assembleDebug --no-daemon -Dorg.gradle.jvmargs=-Xmx1536m
echo "→ $(pwd)/app/build/outputs/apk/debug/app-debug.apk"
