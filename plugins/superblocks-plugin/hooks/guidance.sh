#!/bin/sh
# Adds Superblocks guidance to Claude's context. It reads the hook input on
# stdin and prints at most one JSON line; it reads no files and calls nothing.
#
# - SessionStart: rules for any Claude host (Claude Code or Cowork).
# - PostToolUse and PostToolUseFailure: how to use Cowork's browser pane. Only
#   Cowork names tools mcp__remote-devices__plugin_<plugin>_<server>__<tool>, so
#   Claude Code, which has no browser pane, never gets these lines.
#
# Plain sh on purpose: it is proven to run inside Cowork's VM, Node is not.

input=$(cat)

field() {
  printf '%s' "$input" | sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p"
}

event=$(field hook_event_name)

emit() {
  text=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$event" "$text"
}

# check_app_progress and get_app are polled many times, so their guidance is
# added only when the result carries browserNavigation. Every other tool always
# gets its guidance, whose wording names the status it applies to.
#
# True when the tool result has this word as a JSON key or string value. The
# result text is JSON inside JSON, so the closing quote may be escaped.
has() {
  case "$input" in
    *"$1\\\""* | *"$1\""*) return 0 ;;
  esac
  return 1
}

if [ "$event" = "SessionStart" ]; then
  emit 'When using the Superblocks tools: Do not create a Claude artifact or use the host'\''s own file-upload UI. If the file exists only in this chat'\''s scratchpad path (for example /tmp/claude-.../scratchpad), send text source through upload_artifact files: [{ path, content }] instead of filePath. Do not ask the user to restart Claude. Claude-in-Chrome is not a mid-turn canvas. Do not use it to screenshot the live Vite app while a Gateway turn is held.'
  exit 0
fi

tool=$(field tool_name)
case "$tool" in
  mcp__remote-devices__plugin_*_superblocks__*) ;;
  *) exit 0 ;;
esac

toolsearch='select:mcp__remote-devices__Claude_Browser__preview_start,mcp__remote-devices__Claude_Browser__navigate,mcp__remote-devices__Claude_Browser__tabs_context'
browser_tools="Load your browser pane tools, you will need them. Call ToolSearch with query $toolsearch. When a check_app_progress or get_app result includes browserNavigation, ensure its exact URL is open in Cowork's embedded Page browser before any other action. If that app is already open, do not reload it; otherwise, focus the Page URL field, enter that exact URL, and press Enter. Verify the app loaded; normal authentication or canonical URL redirects are allowed. A blank tab is insufficient. Keep the Page open so the user can watch the live canvas update."
app_load_check="Your automatic verification is a load check and inspection of visible state, not a feature-by-feature test run. Run interactive feature tests only when the user requests testing. Do not click app controls or inspect API traffic as part of a load check; normal navigation and authentication are allowed. Keep relaying Superblocks' own test results. Do not claim features passed from a load check alone."
publish_details="Before any other action, ensure the publishDetailsUrl from this result is open in Cowork's embedded Page browser and verify the publish details loaded."

case "${tool##*__}" in
  start_app | edit_app)
    emit "While this result's status is \"building\": CRITICAL: load your browser pane tools now, before the first poll - call ToolSearch with query $toolsearch. Without them you cannot open the app when a later result carries browserNavigation. In Cowork's embedded Page browser, and only there, you may open this result's \`browser.canvas.editUrl\` now. $browser_tools"
    ;;
  check_app_progress)
    if has browserNavigation; then
      if has decide_in_editor; then
        emit "CRITICAL DO NOT IGNORE: Before any other action, ensure the browserNavigation URL from this result is open in Cowork's embedded Page browser. $browser_tools"
      else
        emit "CRITICAL DO NOT IGNORE: viewStatus is ready, before any other action, ensure the browserNavigation URL from this result is open in Cowork's embedded Page browser and verify the app loaded. $app_load_check $browser_tools"
      fi
    fi
    ;;
  get_app)
    if has browserNavigation; then
      if has decide_in_editor; then
        emit "Before any other action, ensure the browserNavigation URL from this result is open in Cowork's embedded Page browser. $browser_tools"
      else
        emit "Before any other action, ensure the browserNavigation URL from this result is open in Cowork's embedded Page browser and verify the app loaded. $app_load_check $browser_tools"
      fi
    fi
    ;;
  build_app)
    emit "When status is \"ready\": Before any other action, ensure the previewUrl from this result is open in Cowork's embedded Page browser and verify only that the commit preview loaded."
    ;;
  get_preview_status)
    emit "When status is \"ready\": Before any other action, open the exact \`previewUrl\` from the original \`build_app\` result in Cowork's embedded Page browser and verify only that the commit preview loaded."
    ;;
  publish_app)
    emit "On either successful status, open publishDetailsUrl automatically in the browser pane before the first check_publish_progress poll. $publish_details"
    ;;
  check_publish_progress)
    emit "$publish_details"
    ;;
  create_integration)
    case "$input" in
      *sb_integration_setup*) emit "Open the exact returned integration_url in Cowork's browser pane side panel even if the app editor is already open. That URL opens the Integrations tab inside the editor so the user can enter credentials there. Do not navigate to the org Integrations page." ;;
      *) emit "Open the exact returned integration_url in Cowork's browser pane side panel." ;;
    esac
    ;;
  login | set_server)
    emit "Continue in this Cowork task after success."
    ;;
esac
exit 0
