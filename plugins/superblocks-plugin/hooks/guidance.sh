#!/bin/sh
# Adds Superblocks guidance to Claude's context. hooks.json passes the hook
# event as $1, the hook input arrives on stdin, and the script prints at most
# one JSON line. It reads no files and makes no network calls.
#
# - SessionStart: rules for any Claude host (Claude Code or Cowork).
# - PostToolUse and PostToolUseFailure: how to use Cowork's browser pane. Only
#   Cowork names tools mcp__remote-devices__plugin_<plugin>_<server>__<tool>, so
#   Claude Code, which has no browser pane, never gets these lines.
#
# Plain sh on purpose: it is proven to run inside Cowork's VM, Node is not.

event=$1
input=$(cat)

emit() {
  text=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$event" "$text"
}

# The tool result is pretty-printed JSON inside a JSON string, so its quotes
# arrive escaped. Match a key, or a key and its string value, in either form.
has() {
  case "$input" in
    *"\\\"$1\\\":"* | *"\"$1\":"*) return 0 ;;
  esac
  return 1
}
is() {
  case "$input" in
    *"\\\"$1\\\": \\\"$2\\\""* | *"\\\"$1\\\":\\\"$2\\\""*) return 0 ;;
    *"\"$1\": \"$2\""* | *"\"$1\":\"$2\""*) return 0 ;;
  esac
  return 1
}

case "$event" in
  SessionStart)
    emit 'About the Superblocks tools: files the user attaches reach Superblocks through upload_artifact, not through a Claude artifact or the host'\''s own file-upload UI. A file that exists only in this chat'\''s scratchpad path (for example /tmp/claude-.../scratchpad) reaches Superblocks as text source in upload_artifact files: [{ path, content }], not through filePath. Superblocks never needs the user to restart Claude. Claude-in-Chrome is not a mid-turn canvas: it is not used to screenshot the live Vite app while a Gateway turn is held.'
    exit 0
    ;;
  PostToolUse | PostToolUseFailure) ;;
  *) exit 0 ;;
esac

# The first tool_name key is the hook's own; tool_input comes after it.
case "$input" in
  *'"tool_name":'*) ;;
  *) exit 0 ;;
esac
tool=${input#*\"tool_name\":}
tool=${tool#*\"}
tool=${tool%%\"*}
case "$tool" in
  mcp__remote-devices__plugin_*_superblocks__*) ;;
  *) exit 0 ;;
esac

toolsearch='select:mcp__remote-devices__Claude_Browser__preview_start,mcp__remote-devices__Claude_Browser__navigate,mcp__remote-devices__Claude_Browser__tabs_context'
browser_tools="Cowork's browser pane tools load through ToolSearch with query $toolsearch. When a check_app_progress or get_app result includes browserNavigation, its exact URL is shown in Cowork's embedded Page browser before any other action. An app that is already open there is not reloaded; otherwise its URL goes into the Page URL field, followed by Enter. The app counts as loaded after normal authentication or canonical URL redirects; a blank tab does not count. The Page stays open so the user can watch the live canvas update."
app_load_check="Superblocks' automatic verification is a load check and inspection of visible state, not a feature-by-feature test run. Interactive feature tests run only when the user requests testing. A load check does not click app controls or inspect API traffic; normal navigation and authentication are allowed. Superblocks' own test results are still relayed. A load check alone does not show that features passed."
publish_details="This result's publishDetailsUrl is the publish details page, which shows the rollout live. In Cowork it is open in the embedded Page browser before any other action, and the publish details are checked to have loaded."
editor="This result's browserNavigation URL is the Superblocks editor for this app. In Cowork it is open in the embedded Page browser before any other action"

# The gateway checks that the editor answers for get_app, and for
# check_app_progress only once viewStatus is ready. Without browserNavigation,
# the check failed. Other results keep the gateway's own text.
editor_unavailable() {
  [ "$1" = check_app_progress ] && ! is viewStatus ready && return 0
  if is pendingAction open_editor; then
    emit "The build finished but did not save, so the app is not saved. The editor is temporarily unavailable; \`get_app\` called again in a few seconds returns \`browserNavigation\` once it answers. Until a result includes \`browserNavigation\`, the editor is not open for the user."
  elif [ "$1" = get_app ] && is status ready; then
    emit "The editor is temporarily unavailable; \`get_app\` called again in a few seconds returns \`browserNavigation\` once it answers. Until a result includes \`browserNavigation\`, the app is not open for the user."
  fi
}

case "${tool##*__}" in
  start_app | edit_app)
    emit "While this result's status is \"building\", the browser pane tools are needed before the first check_app_progress poll; without them the app cannot be opened when a later result carries browserNavigation. Cowork's embedded Page browser, and only that browser, may show this result's \`browser.canvas.editUrl\` now, while the build runs. $browser_tools"
    ;;
  check_app_progress | get_app)
    if ! has browserNavigation; then
      editor_unavailable "${tool##*__}"
    elif is pendingAction decide_in_editor; then
      emit "$editor, where the user answers this decision. $browser_tools"
    else
      ready=""
      [ "${tool##*__}" = check_app_progress ] && ready="viewStatus is ready. "
      emit "$ready$editor, and the app is checked to have loaded. $app_load_check $browser_tools"
    fi
    ;;
  build_app)
    emit "When status is \"ready\", this result's previewUrl is the commit preview. In Cowork it is open in the embedded Page browser before any other action, and only the preview loading is checked. $browser_tools"
    ;;
  get_preview_status)
    emit "When status is \"ready\", the commit preview is the exact \`previewUrl\` from the original \`build_app\` result. In Cowork it is open in the embedded Page browser before any other action, and only the preview loading is checked. $browser_tools"
    ;;
  publish_app)
    has publishDetailsUrl && emit "On either successful status, Cowork shows publishDetailsUrl in the browser pane automatically, before the first check_publish_progress poll. $publish_details $browser_tools"
    ;;
  check_publish_progress)
    has publishDetailsUrl && emit "$publish_details $browser_tools"
    ;;
  create_integration)
    if has integration_url; then
      case "$input" in
        *sb_integration_setup*) emit "This result's integration_url opens the Integrations tab inside the app editor, where the user enters credentials. In Cowork it opens in the browser pane side panel, even when the app editor is already open there. The org Integrations page is not part of this step. $browser_tools" ;;
        *) emit "This result's integration_url opens the integration in Superblocks. In Cowork it opens in the browser pane side panel. $browser_tools" ;;
      esac
    fi
    ;;
  login)
    emit "In Cowork, a successful login applies to this same task, which continues with the updated account."
    ;;
  set_server)
    emit "In Cowork, a successful server change applies to this same task, which continues after success."
    ;;
esac
exit 0
