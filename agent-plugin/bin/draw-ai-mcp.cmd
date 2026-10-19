@echo off
rem Draw.AI agent plugin: starts the agent bridge that the Draw.AI VS Code extension set up.
if defined DRAWIO_AI_HOME (set "DRAWIO_AI_H=%DRAWIO_AI_HOME%") else (set "DRAWIO_AI_H=%USERPROFILE%\.drawio-ai")
if exist "%DRAWIO_AI_H%\bin\draw-ai-mcp.cmd" (
  call "%DRAWIO_AI_H%\bin\draw-ai-mcp.cmd" %*
  exit /b %ERRORLEVEL%
)
echo Draw.AI: the agent bridge is not set up. Install the Draw.AI extension in VS Code, then run "Draw.AI: Connect Claude Code / Codex..." there. 1>&2
exit /b 1
