!include "LogicLib.nsh"

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ; Delete ONLY ConvoyGate-tracked or ConvoyGate-encrypted .scs files (leaves all user/third-party mods intact)
    nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$modDirs = @('$DOCUMENTS\American Truck Simulator\mod', '$DOCUMENTS\Euro Truck Simulator 2\mod'); $$tracked = @(); foreach ($$f in @('$APPDATA\convoygate-client\managed_mods.json', '$APPDATA\ConvoyGate\managed_mods.json')) { if (Test-Path $$f) { try { $$tracked += (Get-Content $$f -Raw | ConvertFrom-Json) } catch {} } }; foreach ($$d in $$modDirs) { if (Test-Path $$d) { foreach ($$id in $$tracked) { if ($$id) { Remove-Item (Join-Path $$d \"$$id.scs\") -Force -ErrorAction SilentlyContinue } }; Get-ChildItem -Path $$d -Filter *.scs -File | ForEach-Object { try { $$s = [System.IO.File]::OpenRead($$_.FullName); $$b = New-Object byte[] 4; $$n = $$s.Read($$b, 0, 4); $$s.Close(); if ($$n -eq 4 -and (($$b[0] -eq 0x13 -and $$b[1] -eq 0x25 -and $$b[2] -eq 0x6F -and $$b[3] -eq 0x71) -or ($$b[0] -eq 0x10 -and $$b[1] -eq 0x2D -and $$b[2] -eq 0x3F -and $$b[3] -eq 0x56))) { Remove-Item $$_.FullName -Force -ErrorAction SilentlyContinue } } catch {} } } }"`

    Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

    Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

    Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    Delete "D:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

    Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
    Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate_plugin.dll"
    Delete "E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

    RMDir /r "$APPDATA\convoygate-client"
    RMDir /r "$APPDATA\convoygate"
  ${EndIf}
!macroend