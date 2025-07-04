#!/bin/bash

# Linux用のpsycopg2-binaryレイヤーをビルド
echo "Building psycopg2 layer for AWS Lambda (Linux x86_64)..."

# 既存のpythonディレクトリをクリーンアップ
rm -rf python/

# Dockerを使用してLinux環境でビルド
docker run --rm -v "$PWD":/var/task public.ecr.aws/lambda/python:3.11 \
  pip install psycopg2-binary==2.9.9 -t /var/task/python/

echo "Build completed!"