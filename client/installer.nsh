!macro customUnInstall
  ; 1. Delete all ConvoyGate mod packages from Documents
  RMDir /r "$DOCUMENTS\American Truck Simulator\mod"
  RMDir /r "$DOCUMENTS\Euro Truck Simulator 2\mod"

  ; 2. Delete the DLL hook and license key from Steam directories
  Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
  Delete "$PROGRAMFILES\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"
  Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.dll"
  Delete "$PROGRAMFILES64\Steam\steamapps\common\American Truck Simulator\bin\win_x64\plugins\convoygate.key"

  ; 3. Purge user session data
  RMDir /r "$APPDATA\convoygate"
!macroend