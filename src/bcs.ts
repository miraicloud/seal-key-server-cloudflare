import { bcs } from '@mysten/bcs';
import { bcs as suiBcs } from '@mysten/sui/bcs';

const Address = suiBcs.Address;
const Id = Address;

export const RequestFormat = bcs.struct('RequestFormat', {
  ptb: bcs.byteVector(),
  encKey: bcs.byteVector(),
  encVerificationKey: bcs.byteVector(),
});

const PartialKeyServer = bcs.struct('PartialKeyServer', {
  name: bcs.string(),
  url: bcs.string(),
  partialPk: bcs.byteVector(),
  partyId: bcs.u16(),
});

const ServerType = bcs.enum('ServerType', {
  Independent: bcs.struct('Independent', { url: bcs.string() }),
  Committee: bcs.struct('Committee', {
    version: bcs.u32(),
    threshold: bcs.u16(),
    partialKeyServers: bcs.vector(PartialKeyServer),
  }),
});

export const KeyServerV2 = bcs.struct('KeyServerV2', {
  name: bcs.string(),
  keyType: bcs.u8(),
  pk: bcs.byteVector(),
  serverType: ServerType,
});

const MemberInfo = bcs.struct('MemberInfo', {
  encPk: bcs.byteVector(),
  signingPk: bcs.byteVector(),
  url: bcs.string(),
  name: bcs.string(),
});

function Entry<K, KI, V, VI>(key: import('@mysten/bcs').BcsType<K, KI>, value: import('@mysten/bcs').BcsType<V, VI>) {
  return bcs.struct('Entry', { key, value });
}

function VecMap<K, KI, V, VI>(key: import('@mysten/bcs').BcsType<K, KI>, value: import('@mysten/bcs').BcsType<V, VI>) {
  return bcs.struct('VecMap', { contents: bcs.vector(Entry(key, value)) });
}

const MemberInfoMap = VecMap(Address, MemberInfo);
const AddressSet = bcs.struct('VecSet', { contents: bcs.vector(Address) });

const CommitteeState = bcs.enum('CommitteeState', {
  Init: bcs.struct('Init', { membersInfo: MemberInfoMap }),
  PostDKG: bcs.struct('PostDKG', {
    membersInfo: MemberInfoMap,
    partialPks: bcs.vector(bcs.byteVector()),
    pk: bcs.byteVector(),
    messagesHash: bcs.byteVector(),
    approvals: AddressSet,
  }),
  Finalized: null,
});

export const SealCommittee = bcs.struct('SealCommittee', {
  id: Id,
  threshold: bcs.u16(),
  members: bcs.vector(Address),
  state: CommitteeState,
  oldCommitteeId: bcs.option(Id),
});

export const CommitteeFieldWrapper = bcs.struct('Field<Wrapper<ID>, ID>', {
  id: Id,
  name: bcs.struct('Wrapper<ID>', { name: Id }),
  value: Id,
});

const AppInfo = bcs.struct('AppInfo', {
  packageInfoId: bcs.option(Id),
  packageAddress: bcs.option(Address),
  upgradeCapId: bcs.option(Id),
});

const StringMap = VecMap(bcs.string(), bcs.string());

export const AppRecord = bcs.struct('AppRecord', {
  appCapId: Id,
  nsNftId: Id,
  appInfo: bcs.option(AppInfo),
  networks: VecMap(bcs.string(), AppInfo),
  metadata: StringMap,
  storage: Id,
});

const PackageDisplay = bcs.struct('PackageDisplay', {
  gradientFrom: bcs.string(),
  gradientTo: bcs.string(),
  textColor: bcs.string(),
  name: bcs.string(),
  uriEncodedName: bcs.string(),
});

export const PackageInfo = bcs.struct('PackageInfo', {
  id: Id,
  display: PackageDisplay,
  upgradeCapId: Id,
  packageAddress: Address,
  metadata: StringMap,
  gitVersioning: bcs.struct('Table', { id: Id, size: bcs.u64() }),
});

export const MvrName = bcs.struct('Name', {
  org: bcs.struct('Domain', { labels: bcs.vector(bcs.string()) }),
  app: bcs.vector(bcs.string()),
});
