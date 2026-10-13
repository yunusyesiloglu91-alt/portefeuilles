' Lance un passage du robot Prudent / Casino / Sniper 5 min sans fenêtre (tâche Windows "Robot portefeuilles")
Set fso = CreateObject("Scripting.FileSystemObject")
dossier = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dossier
sh.Run "node live\run-pc.js", 0, False
