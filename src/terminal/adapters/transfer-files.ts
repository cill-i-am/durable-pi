import type { Sandbox } from "@cloudflare/sandbox"
import { MAX_TRANSFER_BYTES } from "../transfers"
import { readBounded } from "./sandbox"

const transfer = `import os,sys,stat
mode,path=sys.argv[1:]
parts=path.split('/')
if parts[:2]!=['','workspace'] or any(p in ('','.','..') for p in parts[2:]): raise ValueError('path')
directory=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts[2:-1]:
  if mode=='import':
   try: os.mkdir(part,0o700,dir_fd=directory)
   except FileExistsError: pass
  next_directory=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
  os.close(directory)
  directory=next_directory
 flags=os.O_NOFOLLOW|os.O_NONBLOCK
 flags|=(os.O_WRONLY|os.O_CREAT|os.O_EXCL) if mode=='import' else os.O_RDONLY
 file=os.open(parts[-1],flags,0o600,dir_fd=directory)
 try:
  info=os.fstat(file)
  if not stat.S_ISREG(info.st_mode) or info.st_size>${MAX_TRANSFER_BYTES}: raise ValueError('file')
  if mode=='import':
   with open('/tmp/pi-transfer-input','rb') as source:
    data=source.read(${MAX_TRANSFER_BYTES + 1})
   if not data or len(data)>${MAX_TRANSFER_BYTES}: raise ValueError('size')
   with os.fdopen(os.dup(file),'wb') as target: target.write(data)
  else:
   with os.fdopen(os.dup(file),'rb') as source: data=source.read(${MAX_TRANSFER_BYTES + 1})
   if not data or len(data)>${MAX_TRANSFER_BYTES}: raise ValueError('size')
   with open('/tmp/pi-transfer-output','xb') as target: target.write(data)
 finally: os.close(file)
finally: os.close(directory)
`
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
export function sandboxTransfers(
  sandbox: Sandbox,
  internal: (command: string, signal: AbortSignal) => Promise<void>
) {
  return {
    importFile: async (
      path: string,
      bytes: Uint8Array,
      signal: AbortSignal
    ) => {
      signal.throwIfAborted()
      await sandbox.writeFile(
        "/tmp/pi-transfer-input",
        new Response(bytes.slice().buffer).body!
      )
      signal.throwIfAborted()
      await internal(
        `python3 -c ${quote(transfer)} import ${quote(path)}`,
        signal
      )
    },
    exportFile: async (path: string, signal: AbortSignal) => {
      await internal(
        `python3 -c ${quote(transfer)} export ${quote(path)}`,
        signal
      )
      signal.throwIfAborted()
      const file = await sandbox.readFile("/tmp/pi-transfer-output", {
        encoding: "none",
      })
      return readBounded(file.content, MAX_TRANSFER_BYTES, signal)
    },
  }
}
