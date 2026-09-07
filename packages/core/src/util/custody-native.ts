import { cc, dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, writeFileSync } from "node:fs";

export type CustodyStat = {
  dev: bigint; ino: bigint; mode: bigint; uid: bigint; gid: bigint; ctimeNs: bigint;
};

// This fixed Linux x64 ABI has no pathname request, file-content operation,
// allocator or external compiler. libc installs/restores the signal disposition;
// the blocking loop uses syscalls only. The owner authenticates
// the broker separately; the broker authenticates the main process before recvmsg.
const source = `
typedef unsigned long u64;
typedef unsigned int u32;
static long call(long n,long a,long b,long c,long d,long e,long f) {
  register long r10 __asm__("r10")=d, r8 __asm__("r8")=e, r9 __asm__("r9")=f;
  long r;
  __asm__ volatile("syscall":"=a"(r):"a"(n),"D"(a),"S"(b),"d"(c),"r"(r10),"r"(r8),"r"(r9):"rcx","r11","memory","cc");
  return r;
}
static void zero(void *p,u64 n) { unsigned char *b=p; while(n--) *b++=0; }
static int same(const void *a,const void *b,u64 n) { const unsigned char *x=a,*y=b; while(n--) if(*x++!=*y++) return 0; return 1; }
static void copy(void *a,const void *b,u64 n) { unsigned char *x=a; const unsigned char *y=b; while(n--) *x++=*y++; }
static void closefd(int fd) { if(fd>=0) call(3,fd,0,0,0,0,0); }
struct stat64 { u64 dev,ino,nlink; u32 mode,uid,gid,pad; u64 rdev; long size,blocksize,blocks,atime,atimeNs,mtime,mtimeNs,ctime,ctimeNs,reserved[3]; };
struct metadata { u64 dev,ino,mode,uid,gid,ctimeNs; };
_Static_assert(sizeof(struct stat64)==144,"Linux x64 stat ABI");
_Static_assert(sizeof(struct metadata)==48,"metadata ABI");
static int metadata(int fd,struct metadata *out,int directory) {
  struct stat64 s;
  if(call(5,fd,(long)&s,0,0,0,0)<0 || (directory && (s.mode&0170000)!=0040000)) return -1;
  out->dev=s.dev; out->ino=s.ino; out->mode=s.mode; out->uid=s.uid; out->gid=s.gid;
  if(s.ctimeNs<0 || s.ctimeNs>=1000000000L) return -1;
  out->ctimeNs=(u64)s.ctime*1000000000UL+(u64)s.ctimeNs;
  return 0;
}
static int stable(const struct metadata *a,const struct metadata *b) {
  return a->dev==b->dev && a->ino==b->ino && a->mode==b->mode && a->ctimeNs==b->ctimeNs;
}
struct pollfd { int fd; short events,revents; };
static volatile int stopping=0;
static void stop(int ignored) { stopping=1; }
struct signal_action { void *handler; u64 mask[16]; int flags,pad; void *restorer; };
_Static_assert(sizeof(struct signal_action)==152,"glibc Linux x64 sigaction ABI");
static int (*signal_fn)(int,const struct signal_action *,struct signal_action *);
void custody_initialize(void *signal) { signal_fn=(int (*)(int,const struct signal_action *,struct signal_action *))signal; }
int custody_watch_pid(int pid) { return (int)call(434,pid,0,0,0,0,0); }
static long now_ms(void) {
  long t[2]; if(call(228,1,(long)t,0,0,0,0)<0) return -1;
  return t[0]*1000L+t[1]/1000000L;
}
static long deadline(int timeout) { long now=now_ms(); return now<0 ? -1 : now+timeout; }
// 1 alive, 0 exited, -1 unavailable. An invalid pidfd is never clean shutdown.
static int main_alive(int pidfd) {
  long end=deadline(1000); if(end<0) return -1;
  for(;;) {
    struct pollfd p={pidfd,1,0}; long r=call(7,(long)&p,1,0,0,0,0);
    if(r==-4) { long now=now_ms(); if(now<0 || now>=end) return -1; continue; }
    if(r==0) return 1;
    return r==1 && (p.revents&(1|16)) && !(p.revents&(8|32)) ? 0 : -1;
  }
}
static int server_wait(int fd,int pidfd,int timeout,int started) {
  long end=timeout<0 ? 0 : deadline(timeout); if(end<0) return -1;
  for(;;) {
    int alive=main_alive(pidfd); if(alive<0) return -1;
    if((stopping && !started) || alive==0) return -2;
    int step=500;
    if(timeout>=0) { long now=now_ms(); if(now<0 || now>=end) return -1; if(end-now<step) step=(int)(end-now); }
    struct pollfd p[2]={{fd,1,0},{pidfd,1,0}};
    long r=call(7,(long)p,2,step,0,0,0);
    if(stopping && !started) return -2;
    if(r==-4) continue;
    if(r<0) return -1;
    if(p[1].revents) return (p[1].revents&(1|16)) && !(p[1].revents&(8|32)) ? -2 : -1;
    if(r>0) return (p[0].revents&1) && !(p[0].revents&(8|32)) ? 1 : -1;
  }
}
static int waitfd(int fd,short events,long end) {
  if(end<0) return -1;
  for(;;) {
    long now=now_ms(); if(now<0 || now>=end) return -1;
    struct pollfd p={fd,events,0};
    long r=call(7,(long)&p,1,end-now,0,0,0);
    if(r==-4) continue;
    return r==1 && (p.revents&events) && !(p.revents&(8|32)) ? p.revents : -1;
  }
}

struct credentials { int pid; u32 uid,gid; };
int custody_peer(int fd,struct credentials *out) {
  u32 n=sizeof(*out); int type=0; u32 tn=sizeof(type);
  if(call(55,fd,1,3,(long)&type,(long)&tn,0)<0 || type!=5 || tn!=sizeof(type)) return -1;
  return call(55,fd,1,17,(long)out,(long)&n,0)==0 && n==sizeof(*out) && out->pid>0 ? 0 : -1;
}
struct address { unsigned short family; char path[108]; };
static int address(int dir,const char *name,struct address *out) {
  struct metadata m; if(metadata(dir,&m,1)<0) return -1;
  zero(out,sizeof(*out)); out->family=1;
  const char prefix[]="/proc/self/fd/"; int k=0;
  for(int i=0;prefix[i];i++) out->path[k++]=prefix[i];
  char digits[10]; int n=0, value=dir;
  if(value<0) return -1;
  do { digits[n++]=(char)('0'+value%10); value/=10; } while(value);
  while(n) out->path[k++]=digits[--n]; out->path[k++]='/';
  int i=0; for(;name[i];i++) { unsigned char c=name[i];
    if(i>=64 || !((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'||c=='.')) return -1;
    out->path[k++]=c;
  }
  if(i==0 || (i==1&&name[0]=='.') || (i==2&&name[0]=='.'&&name[1]=='.') || k>=108) return -1;
  return 2+k+1;
}
int custody_listen(int dir,const char *name) {
  struct address a; int len=address(dir,name,&a); if(len<0) return -1;
  struct stat64 old;
  if(call(262,dir,(long)name,(long)&old,0x100,0,0)!=-2) return -1;
  int fd=(int)call(41,1,5|0x80000|0x800,0,0,0,0); if(fd<0) return -1;
  long mask=call(95,0177,0,0,0,0,0);
  long bound=call(49,fd,(long)&a,len,0,0,0);
  call(95,mask,0,0,0,0,0);
  if(bound<0) { closefd(fd); return -1; }
  int pathfd=(int)call(257,dir,(long)name,0x200000|0x20000|0x80000,0,0,0);
  struct metadata endpoint;
  int ok=pathfd>=0 && metadata(pathfd,&endpoint,0)==0 && (endpoint.mode&0170000)==0140000 &&
    (endpoint.mode&07777)==0600 && endpoint.uid==(u64)call(107,0,0,0,0,0,0);
  closefd(pathfd);
  if(!ok || call(50,fd,1,0,0,0,0)<0) { closefd(fd); return -1; }
  return fd;
}
int custody_connect(int dir,const char *name) {
  struct address a; int len=address(dir,name,&a); if(len<0) return -1;
  struct stat64 s;
  if(call(262,dir,(long)name,(long)&s,0x100,0,0)<0 || (s.mode&0170000)!=0140000 || (s.mode&07777)!=0600) return -1;
  int fd=(int)call(41,1,5|0x80000|0x800,0,0,0,0); if(fd<0) return -1;
  if(call(42,fd,(long)&a,len,0,0,0)<0) { closefd(fd); return -1; }
  return fd;
}
struct header { u32 magic,version,kind,reserved; unsigned char binding[16]; };
struct reply { struct header header; struct metadata metadata; };
struct iovec { void *base; u64 len; };
struct message { void *name; u32 namelen,pad; struct iovec *iov; u64 iovlen; void *control; u64 controllen; u32 flags,pad2; };
struct control { u64 len; int level,type; };
_Static_assert(sizeof(struct header)==32,"request ABI");
_Static_assert(sizeof(struct reply)==80,"reply ABI");
_Static_assert(sizeof(struct message)==56,"msghdr ABI");
static void header(struct header *h,const unsigned char *binding) {
  zero(h,sizeof(*h)); h->magic=0x4b435331; h->version=1; h->kind=1; copy(h->binding,binding,16);
}
// Consume and close every delivered descriptor, including malformed/truncated
// messages. Linux closes rights that do not fit the receiving control buffer.
static int receive(int socket,void *data,u64 size,int *one,int timeout) {
  long end=deadline(timeout==-2 ? 1000 : timeout); if(end<0) return -1;
  unsigned char controls[2048]; zero(controls,sizeof(controls));
  struct iovec io={data,size}; struct message m; zero(&m,sizeof(m));
  long got;
  for(;;) {
    if(timeout!=-2 && waitfd(socket,1,end)<0) return -1;
    zero(&m,sizeof(m)); m.iov=&io; m.iovlen=1; m.control=controls; m.controllen=sizeof(controls);
    got=call(47,socket,(long)&m,0x40000000|0x40,0,0,0); // CMSG_CLOEXEC | DONTWAIT
    if(got!=-4) break;
    timeout=1000; // Keep the original absolute deadline across interruptions.
  }
  if(got<0) return -1;
  int count=0,held=-1,bad=0; u64 pos=0;
  while(pos+sizeof(struct control)<=m.controllen) {
    struct control *c=(void *)(controls+pos);
    if(c->len<sizeof(*c) || c->len>m.controllen-pos) { bad=1; break; }
    u64 bytes=c->len-sizeof(*c);
    if(c->level!=1 || c->type!=1 || bytes%sizeof(int)) bad=1;
    if(c->level==1 && c->type==1) {
      int *fds=(void *)(c+1); u64 n=bytes/sizeof(int);
      for(u64 i=0;i<n;i++) { count++; if(count==1) held=fds[i]; else closefd(fds[i]); }
    }
    pos+=(c->len+7)&~7UL;
  }
  if(m.flags&(8|32)) bad=1; // CTRUNC | TRUNC
  if(got==0 && count==0 && !bad) {
    struct pollfd p={socket,1|8192,0};
    return call(7,(long)&p,1,0,0,0,0)==1 && (p.revents&(16|8192)) ? 0 : -1;
  }
  if(got!=(long)size || bad || (one ? count!=1 : count!=0)) { closefd(held); return -1; }
  if(one) *one=held; else closefd(held);
  return 1;
}
static int senddata(int socket,const void *data,u64 size,int directory) {
  long end=deadline(1000); if(end<0) return -1;
  unsigned char controls[24]; zero(controls,sizeof(controls));
  struct iovec io={(void *)data,size}; struct message m; zero(&m,sizeof(m)); m.iov=&io; m.iovlen=1;
  if(directory>=0) {
    struct control *c=(void *)controls; c->len=20; c->level=1; c->type=1; *(int *)(c+1)=directory;
    m.control=controls; m.controllen=sizeof(controls);
  }
  for(;;) {
    if(waitfd(socket,4,end)<0) return -1;
    long sent=call(46,socket,(long)&m,0x4000|0x40,0,0,0); // NOSIGNAL | DONTWAIT
    if(sent!=-4) return sent==(long)size ? 0 : -1;
  }
}
int custody_stat(int socket,int directory,const unsigned char *binding,struct metadata *out) {
  struct metadata before,after; struct header request; struct reply reply;
  if(metadata(directory,&before,1)<0) return -1;
  header(&request,binding);
  if(senddata(socket,&request,sizeof(request),directory)<0 || receive(socket,&reply,sizeof(reply),0,1000)!=1 ||
      !same(&request,&reply.header,sizeof(request)) || metadata(directory,&after,1)<0 ||
      !stable(&before,&after) || before.uid!=after.uid || before.gid!=after.gid || !stable(&before,&reply.metadata)) {
    call(48,socket,2,0,0,0,0); return -1;
  }
  *out=reply.metadata; return 0;
}
int custody_healthy(int socket) {
  long end=deadline(1000); if(end<0) return 0;
  for(;;) {
    struct pollfd p={socket,1,0}; long r=call(7,(long)&p,1,0,0,0,0);
    if(r!=-4) return r==0; // Data, EOF or error is not an idle valid channel.
    long now=now_ms(); if(now<0 || now>=end) return 0;
  }
}
int custody_serve(int listener,int mainPid,u32 ownerUid,const unsigned char *binding,int ready,int mainPidFd) {
  if(!signal_fn || main_alive(mainPidFd)!=1) return -1;
  stopping=0; struct signal_action previous,action; zero(&action,sizeof(action)); action.handler=(void *)stop;
  if(signal_fn(15,&action,&previous)!=0) return -1;
  int result=-1,socket=-1,started=0;
  int waiting=server_wait(listener,mainPidFd,10000,0);
  if(waiting==-2) { result=0; goto finish; }
  if(waiting<0) goto finish;
  socket=(int)call(288,listener,0,0,0x80000|0x800,0,0);
  if(socket<0) goto finish;
  struct credentials peer; struct header expected; header(&expected,binding);
  if(custody_peer(socket,&peer)<0 || peer.pid!=mainPid || peer.uid!=ownerUid) goto finish;
  for(;;) {
    waiting=server_wait(socket,mainPidFd,started ? -1 : 10000,started);
    if(waiting==-2) { result=0; break; }
    if(waiting<0) break;
    struct header request; int fd=-1;
    int received=receive(socket,&request,sizeof(request),&fd,-2);
    if(received==0) { result=started ? 0 : -1; break; }
    if(received<0) break;
    struct reply reply; reply.header=expected;
    int valid=same(&request,&expected,sizeof(request)) && metadata(fd,&reply.metadata,1)==0;
    closefd(fd);
    if(!valid) break;
    int alive=main_alive(mainPidFd); if(alive<0) break;
    if(alive==0 || (stopping && !started)) { result=0; break; }
    if(senddata(socket,&reply,sizeof(reply),-1)<0) break;
    if(!started) {
      if(main_alive(mainPidFd)!=1 || stopping) break;
      long end=deadline(1000),written=-1;
      while(!stopping && waitfd(ready,4,end)>=0) {
        written=call(1,ready,(long)"READY\\n",6,0,0,0);
        if(written!=-4) break;
      }
      // An interrupted/partial/ambiguous READY publication is bootstrap failure.
      if(written!=6 || stopping || main_alive(mainPidFd)!=1) break;
      started=1;
    }
  }
finish:
  closefd(socket);
  if(signal_fn(15,&previous,0)!=0) result=-1;
  return result;
}

struct filter { unsigned short code; unsigned char jt,jf; u32 k; };
struct program { unsigned short len; struct filter *filter; };
int custody_restrict(void) {
  // Verify native syscall ABI, reject x32, then inspect argument0 for both
  // socket and socketpair. TSYNC covers Bun threads that already exist.
  struct filter f[]={
    {0x20,0,0,4}, {0x15,1,0,0xc000003e}, {0x06,0,0,0x80000000},
    {0x20,0,0,0}, {0x45,0,1,0x40000000}, {0x06,0,0,0x00050001},
    {0x15,2,0,41}, {0x15,1,0,53}, {0x06,0,0,0x7fff0000},
    {0x20,0,0,16}, {0x15,1,0,1}, {0x06,0,0,0x00050001}, {0x06,0,0,0x7fff0000}
  };
  struct program p={sizeof(f)/sizeof(f[0]),f};
  if(call(157,38,1,0,0,0,0)!=0) return -1;
  return call(317,1,1,(long)&p,0,0,0)==0 ? 0 : -1;
}
`;

function fail(): never { throw new Error("custody_native_unavailable"); }
function descriptor(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) fail();
  return value;
}
function bindingBytes(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16) fail();
  return Buffer.from(value);
}
function basename(value: string): Buffer {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(value) || value === "." || value === "..") fail();
  return Buffer.from(`${value}\0`);
}

function load() {
  if (process.platform !== "linux" || process.arch !== "x64") fail();
  const libc = dlopen("libc.so.6", {
    memfd_create: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const label = Buffer.from("kizuki-custody-native\0");
  const fd = libc.symbols.memfd_create(ptr(label), 3);
  try {
    if (fd < 0) fail();
    writeFileSync(fd, source);
    if (libc.symbols.fcntl(fd, 1033, 15) !== 0 || libc.symbols.fcntl(fd, 1034, 0) !== 15) fail();
    const compiled = cc({ flags: ["-nostdlib", "-x", "c"], source: `/proc/self/fd/${fd}`, symbols: {
      custody_initialize: { args: [FFIType.ptr], returns: FFIType.void },
      custody_watch_pid: { args: [FFIType.i32], returns: FFIType.i32 },
      custody_listen: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      custody_connect: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      custody_peer: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      custody_restrict: { args: [], returns: FFIType.i32 },
      custody_serve: { args: [FFIType.i32, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      custody_stat: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      custody_healthy: { args: [FFIType.i32], returns: FFIType.i32 },
    } });
    const native = compiled.symbols;
    const signal = libc.symbols.dlsym(null, ptr(Buffer.from("sigaction\0")));
    if (!signal) { compiled.close(); fail(); }
    native.custody_initialize(signal);
    retained = { libc, compiled };
    return {
      watchPid(pid: number): number {
        if (!Number.isInteger(pid) || pid < 1 || pid > 0x7fffffff) fail();
        const fd = native.custody_watch_pid(pid); return fd < 0 ? fail() : fd;
      },
      listen(controlFd: number, name: string): number {
        const bytes = basename(name); const result = native.custody_listen(descriptor(controlFd), ptr(bytes));
        return result < 0 ? fail() : result;
      },
      connect(controlFd: number, name: string): number {
        const bytes = basename(name); const result = native.custody_connect(descriptor(controlFd), ptr(bytes));
        return result < 0 ? fail() : result;
      },
      peer(socketFd: number): { pid: number; uid: number; gid: number } {
        const out = Buffer.alloc(12);
        if (native.custody_peer(descriptor(socketFd), ptr(out)) !== 0) fail();
        return { pid: out.readInt32LE(0), uid: out.readUInt32LE(4), gid: out.readUInt32LE(8) };
      },
      restrictBroker(): void { if (native.custody_restrict() !== 0) fail(); },
      serve(listenerFd: number, mainPid: number, ownerUid: number, binding: Uint8Array, readyFd: number, mainPidFd: number): number {
        if (!Number.isInteger(mainPid) || mainPid < 1 || mainPid > 0x7fffffff || !Number.isInteger(ownerUid) || ownerUid < 0 || ownerUid > 0xffffffff) fail();
        const bytes = bindingBytes(binding);
        return native.custody_serve(descriptor(listenerFd), mainPid, ownerUid, ptr(bytes), descriptor(readyFd), descriptor(mainPidFd));
      },
      stat(socketFd: number, directoryFd: number, binding: Uint8Array): CustodyStat {
        const bytes = bindingBytes(binding); const out = Buffer.alloc(48);
        if (native.custody_stat(descriptor(socketFd), descriptor(directoryFd), ptr(bytes), ptr(out)) !== 0) fail();
        return { dev: out.readBigUInt64LE(0), ino: out.readBigUInt64LE(8), mode: out.readBigUInt64LE(16),
          uid: out.readBigUInt64LE(24), gid: out.readBigUInt64LE(32), ctimeNs: out.readBigUInt64LE(40) };
      },
      healthy(socketFd: number): boolean { return native.custody_healthy(descriptor(socketFd)) === 1; },
    };
  } catch { libc.close(); fail(); }
  finally { if (fd >= 0) closeSync(fd); }
}
let retained: unknown; // Keep both native library handles alive with the cached API.
let cached: ReturnType<typeof load> | undefined;
export function custodyNative(): ReturnType<typeof load> { return cached ??= load(); }
