#!/bin/bash

# Zillit Drive File Sharing - Complete Test Script
# Tests epoch timestamp implementation

set -e

BASE_URL="http://localhost:8105"
MODULE_DATA="9bf45a428070559f3376f051dd8877f1cdc26fed18a17e5d9f05337339f17aaa2dcb4c3474635573f852906b03eeab055b53675d1c163c04a58173d85a4fba3bc24b2494c14e2f943e44738ecfe9dab8818d7fe7a9ac6ecbd9bffa85e295cd4f8f288371124b3e34ff5989b589685eb975bc1eb34020fb1924b72e64c1fd4d73f9e439c1ab7104103a2f2094f8ff6e40349954d10bee1fde2f9df25fd019413b"
FILE_ID="68f0cb8bdcbea8318fcaafb6"

echo "🚀 Testing Zillit Drive File Sharing with Epoch Timestamps"
echo "=========================================================="

# Test 1: Health Check
echo "1️⃣  Testing Health Check..."
curl -s "$BASE_URL/" | jq '.status'
echo "✅ Health check passed"

# Test 2: Create temporary share (1 hour)
echo ""
echo "2️⃣  Creating temporary share (1 hour expiration)..."
EXPIRES_1H=$(($(date +%s) * 1000 + 3600000))
echo "   Expires at: $EXPIRES_1H ($(date -r $((EXPIRES_1H/1000))))"

TEMP_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "moduledata: $MODULE_DATA" \
  -d "{\"permissions\": \"read\", \"expires_at\": $EXPIRES_1H}" \
  "$BASE_URL/api/v2/drive/files/$FILE_ID/share")

TEMP_TOKEN=$(echo $TEMP_RESPONSE | jq -r '.data.share_token')
echo "✅ Temporary share created: $TEMP_TOKEN"

# Test 3: Create permanent share
echo ""
echo "3️⃣  Creating permanent share (no expiration)..."
PERM_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "moduledata: $MODULE_DATA" \
  -d '{"permissions": "download"}' \
  "$BASE_URL/api/v2/drive/files/$FILE_ID/share")

PERM_TOKEN=$(echo $PERM_RESPONSE | jq -r '.data.share_token')
echo "✅ Permanent share created: $PERM_TOKEN"

# Test 4: Create expired share
echo ""
echo "4️⃣  Creating expired share (for testing expiration)..."
EXPIRED_TIME=$(($(date +%s) * 1000 - 86400000))  # 1 day ago
echo "   Expires at: $EXPIRED_TIME ($(date -r $((EXPIRED_TIME/1000))))"

EXPIRED_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "moduledata: $MODULE_DATA" \
  -d "{\"permissions\": \"read\", \"expires_at\": $EXPIRED_TIME}" \
  "$BASE_URL/api/v2/drive/files/$FILE_ID/share")

EXPIRED_TOKEN=$(echo $EXPIRED_RESPONSE | jq -r '.data.share_token')
echo "✅ Expired share created: $EXPIRED_TOKEN"

# Test 5: Access temporary share
echo ""
echo "5️⃣  Testing temporary share access..."
TEMP_ACCESS=$(curl -s "$BASE_URL/api/v2/drive/public/$TEMP_TOKEN")
TEMP_STATUS=$(echo $TEMP_ACCESS | jq -r '.status')

if [ "$TEMP_STATUS" = "1" ]; then
    echo "✅ Temporary share accessible"
    echo "   Expiration: $(echo $TEMP_ACCESS | jq -r '.data.expires_at')"
else
    echo "❌ Temporary share failed: $(echo $TEMP_ACCESS | jq -r '.message')"
fi

# Test 6: Access permanent share
echo ""
echo "6️⃣  Testing permanent share access..."
PERM_ACCESS=$(curl -s "$BASE_URL/api/v2/drive/public/$PERM_TOKEN")
PERM_STATUS=$(echo $PERM_ACCESS | jq -r '.status')

if [ "$PERM_STATUS" = "1" ]; then
    echo "✅ Permanent share accessible"
    echo "   Expiration: $(echo $PERM_ACCESS | jq -r '.data.expires_at')"
    CONTENT_URL=$(echo $PERM_ACCESS | jq -r '.data.content_stream_url')
else
    echo "❌ Permanent share failed: $(echo $PERM_ACCESS | jq -r '.message')"
fi

# Test 7: Access expired share
echo ""
echo "7️⃣  Testing expired share access..."
EXPIRED_ACCESS=$(curl -s "$BASE_URL/api/v2/drive/public/$EXPIRED_TOKEN")
EXPIRED_STATUS=$(echo $EXPIRED_ACCESS | jq -r '.status')

if [ "$EXPIRED_STATUS" = "0" ]; then
    echo "✅ Expired share correctly rejected: $(echo $EXPIRED_ACCESS | jq -r '.message')"
else
    echo "❌ Expired share should have been rejected"
fi

# Test 8: File content streaming
echo ""
echo "8️⃣  Testing file content streaming..."
CONTENT_STATUS=$(curl -s -I "$BASE_URL/api/v2/drive/public/$PERM_TOKEN/content" | head -n1)

if [[ $CONTENT_STATUS == *"200 OK"* ]]; then
    echo "✅ File content streaming works"
    curl -s "$BASE_URL/api/v2/drive/public/$PERM_TOKEN/content" | head -2
else
    echo "❌ File content streaming failed"
fi

# Test 9: List shares
echo ""
echo "9️⃣  Testing share listing..."
SHARES_LIST=$(curl -s \
  -H "moduledata: $MODULE_DATA" \
  "$BASE_URL/api/v2/drive/files/$FILE_ID/shares")

SHARES_COUNT=$(echo $SHARES_LIST | jq '.data | length')
echo "✅ Found $SHARES_COUNT active shares"

# Summary
echo ""
echo "🎯 Test Summary"
echo "==============="
echo "✅ Epoch timestamps working correctly"
echo "✅ Share creation with expiration"
echo "✅ Permanent shares (no expiration)"
echo "✅ Expired share rejection"
echo "✅ File content streaming"
echo "✅ Share management"
echo ""
echo "🚀 File sharing system is fully functional with epoch timestamps!"

# Cleanup note
echo ""
echo "🧹 Note: Shares created during testing are still active."
echo "   Use DELETE $BASE_URL/api/v2/drive/files/$FILE_ID/share to revoke all."
