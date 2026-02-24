#!/usr/bin/env bash
# docs:list — List and optionally cat project documentation for agent context loading
#
# Usage:
#   ./scripts/docs-list.sh                  # List all docs
#   ./scripts/docs-list.sh --cat            # Print contents of all docs
#   ./scripts/docs-list.sh --cat <keyword>  # Print docs matching keyword
#   ./scripts/docs-list.sh <keyword>        # List docs matching keyword

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$PROJECT_ROOT/docs"
AGENTS_FILE="$PROJECT_ROOT/AGENTS.md"

CAT_MODE=false
KEYWORD=""

# Parse args
for arg in "$@"; do
  case "$arg" in
    --cat) CAT_MODE=true ;;
    *) KEYWORD="$arg" ;;
  esac
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📚 Project Documentation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Always show AGENTS.md
if [[ -f "$AGENTS_FILE" ]]; then
  echo ""
  echo "🤖 AGENTS.md"
  if $CAT_MODE; then
    echo "---"
    cat "$AGENTS_FILE"
    echo ""
    echo "---"
  fi
fi

# List/cat docs
if [[ -d "$DOCS_DIR" ]]; then
  echo ""
  echo "📁 docs/"

  find "$DOCS_DIR" -name "*.md" -o -name "*.yaml" -o -name "*.yml" | sort | while read -r file; do
    relative="${file#$PROJECT_ROOT/}"
    filename="$(basename "$file")"

    # Filter by keyword if provided
    if [[ -n "$KEYWORD" ]]; then
      if ! echo "$filename" | grep -qi "$KEYWORD"; then
        continue
      fi
    fi

    echo "  → $relative"

    if $CAT_MODE; then
      echo "  ---"
      sed 's/^/  /' "$file"
      echo ""
      echo "  ---"
    fi
  done
else
  echo ""
  echo "⚠️  No docs/ directory found"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

