#!/bin/bash

# Simple File Sharing Test Script
echo "🧪 File Sharing Tests"
echo "===================="

# Configuration
MODULE_DATA="9bf45a428070559f3376f051dd8877f1cdc26fed18a17e5d9f05337339f17aaa2dcb4c3474635573f852906b03eeab055b53675d1c163c04a58173d85a4fba3bc24b2494c14e2f943e44738ecfe9dab8818d7fe7a9ac6ecbd9bffa85e295cd4f8f288371124b3e34ff5989b589685eb975bc1eb34020fb1924b72e64c1fd4d73f9e439c1ab7104103a2f2094f8ff6e40349954d10bee1fde2f9df25fd019413b"
FILE_ID="68f0cb8bdcbea8318fcaafb6"

echo ""
echo "✅ 1. Health Check:"
curl -s http://localhost:8105/

echo ""
echo ""
echo "✅ 2. Get File Details:"
curl -s -H "moduledata: $MODULE_DATA" \
"http://localhost:8105/api/v2/drive/files/$FILE_ID"

echo ""
echo ""
echo "❌ 3. Test Share Link Generation:"
curl -s -X POST \
-H "Content-Type: application/json" \
-H "moduledata: $MODULE_DATA" \
-d '{"permissions":"read","expires_at":"2026-12-31T23:59:59Z"}' \
"http://localhost:8105/api/v2/drive/files/$FILE_ID/share"

echo ""
echo ""
echo "❌ 4. Test Public Link Access:"
curl -s -H "moduledata: $MODULE_DATA" \
"http://localhost:8105/api/v2/drive/public/test-token-123"

echo ""
echo ""
echo "❌ 5. Test Share Management:"
curl -s -H "moduledata: $MODULE_DATA" \
"http://localhost:8105/api/v2/drive/files/$FILE_ID/shares"

echo ""
echo ""
echo "📋 Test Results Summary:"
echo "- ✅ Health Check: Available"
echo "- ✅ File Details: Available" 
echo "- ❌ Share Link Generation: Not Implemented"
echo "- ❌ Public Link Access: Not Implemented"
echo "- ❌ Share Management: Not Implemented"
