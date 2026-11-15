@echo off
rem Start a Claude Code session as one demo persona.
rem   persona.cmd analyst-b analyst
rem   persona.cmd manager manager
rem   persona.cmd engineer engineer detection-eng
rem The soc-ir-profile plugin must be installed (skills, /incident, hook). This launcher only
rem overrides WHO you are: it connects to incident-mcp with this persona's name, role and team.
if "%~1"=="" (
  echo Usage: persona.cmd ^<name^> ^<analyst^|lead^|manager^|engineer^> [team]
  exit /b 1
)
set "IR_ANALYST_NAME=%~1"
set "IR_ANALYST_ROLE=%~2"
if "%IR_ANALYST_ROLE%"=="" set "IR_ANALYST_ROLE=analyst"
set "IR_ANALYST_TEAM=%~3"
if "%IR_SERVER_URL%"=="" set "IR_SERVER_URL=http://127.0.0.1:7400"
set "CFG=%TEMP%\ir-persona-%IR_ANALYST_NAME%.json"
> "%CFG%" echo {"mcpServers":{"incident-mcp":{"type":"http","url":"%IR_SERVER_URL%/mcp","headers":{"X-Analyst-Name":"%IR_ANALYST_NAME%","X-Analyst-Role":"%IR_ANALYST_ROLE%","X-Analyst-Team":"%IR_ANALYST_TEAM%"}}}}
title %IR_ANALYST_NAME% (%IR_ANALYST_ROLE%)
claude --strict-mcp-config --mcp-config "%CFG%"
