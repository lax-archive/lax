/-
Stage-0 probe for decision 4: read a tag attribute's persisted entries as
data, the way the Lax inspector reads `moduleDocExt`/`declRangeExt`. This
executable imports only `Lean` — never `LaxCore` — and loads the oleans with
`loadExts := false`, so no imported initializer runs and the attribute is
never registered in this process.

Usage: tagreader <extension-name> <module> [<module>...]
Prints, for each module given on the command line, every persistent-extension
name present in its `ModuleData.entries` with the entry count, then the names
tagged under `<extension-name>` in every loaded module, with the facts the
inspector would re-judge (kind, raw type is `Sort 0`, private).
-/
import Lean

open Lean

def kindOf : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .defnInfo _ => "def"
  | .thmInfo _ => "theorem"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quot"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "ctor"
  | .recInfo _ => "rec"

unsafe def main (args : List String) : IO UInt32 := do
  let extStr :: mods := args
    | IO.eprintln "usage: tagreader <extension-name> <module> [<module>...]"; return 1
  let extName := extStr.toName
  initSearchPath (← findSysroot)
  let modNames := mods.toArray.map String.toName
  let imports := modNames.map fun m => ({ module := m } : Import)
  let env ← importModules imports {} (trustLevel := 1024) (loadExts := false)
  let names := env.header.moduleNames
  let datas := env.header.moduleData
  IO.println s!"loaded {names.size} modules; looking for extension `{extName}`"
  for i in [0:names.size] do
    if modNames.contains names[i]! then
      IO.println s!"-- extensions with entries in {names[i]!}:"
      for (n, es) in datas[i]!.entries do
        IO.println s!"   {n}  ({es.size} entries)"
  let mut hits := 0
  for i in [0:names.size] do
    for (n, es) in datas[i]!.entries do
      if (privateToUserName? n).getD n == extName then
        for e in es do
          let decl := (unsafeCast e : Name)
          hits := hits + 1
          let facts := match env.find? decl with
            | some ci =>
              let isProp := match ci.type.consumeMData with
                | .sort .zero => true
                | _ => false
              s!"kind={kindOf ci} isProp={isProp} private={isPrivateName decl} levelParams={ci.levelParams}"
            | none => "NOT IN ENVIRONMENT"
          IO.println s!"tagged: {names[i]!} :: {decl}  [{facts}]"
  IO.println s!"{hits} tagged declaration(s)"
  return 0
