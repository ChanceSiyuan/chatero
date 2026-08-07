CHATERO_ROOT="$DIR/.."
if [ -f "$CHATERO_ROOT/app/chatero-product.json" ] && [ -f "$CHATERO_ROOT/scripts/chatero/generate-product.mjs" ]; then
	node "$CHATERO_ROOT/scripts/chatero/generate-product.mjs" --root "$CHATERO_ROOT" || return 1
	. "$DIR/chatero-product.sh"
fi
unset CHATERO_ROOT
