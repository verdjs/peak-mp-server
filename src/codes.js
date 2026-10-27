// Photon LoadBalancing codes used by the game's client (Photon Realtime / PUN 2).

export const OP = {
  Ping: 1,                 // internal operation
  GetRegions: 220,
  JoinRandomGame: 225,
  JoinGame: 226,
  CreateGame: 227,
  LeaveLobby: 228,
  JoinLobby: 229,
  Authenticate: 230,
  AuthOnce: 231,
  ChangeGroups: 248,
  GetProperties: 251,
  SetProperties: 252,
  RaiseEvent: 253,
  Leave: 254,
};

export const EV = { AppStats: 226, PropertiesChanged: 253, Leave: 254, Join: 255 };

export const P = {
  RoomOptionFlags: 191,
  Cluster: 196,
  MasterClientId: 203,
  Region: 210,
  JoinMode: 215,
  AppVersion: 220,
  Token: 221,
  Position: 223,
  ApplicationId: 224,
  UserId: 225,
  MasterPeerCount: 227,
  GameCount: 228,
  PeerCount: 229,
  Address: 230,
  ExpectedValues: 231,
  CheckUserOnJoin: 232,
  IsInactive: 233,
  EmptyRoomTTL: 236,
  PlayerTTL: 235,
  Add: 238,
  Remove: 239,          // ChangeGroups
  PublishUserId: 239,   // CreateGame
  Group: 240,
  CleanupCacheOnLeave: 241,
  Code: 244,
  Data: 245,
  ReceiverGroup: 246,
  Cache: 247,
  GameProperties: 248,
  PlayerProperties: 249,
  Broadcast: 250,
  Properties: 251,
  ActorList: 252,
  TargetActorNr: 253,
  ActorNr: 254,
  RoomName: 255,
};

// keys inside the room property table
export const GP = {
  MaxPlayersInt: 243, EmptyRoomTtl: 245, PlayerTtl: 246, ExpectedUsers: 247, MasterClientId: 248,
  CleanupCacheOnLeave: 249, PropsListedInLobby: 250, IsOpen: 253, IsVisible: 254, MaxPlayers: 255,
};
// keys inside an actor property table
export const AP = { UserId: 253, IsInactive: 254, PlayerName: 255 };

export const FLAG = {
  CheckUserOnJoin: 0x01, DeleteCacheOnLeave: 0x02, SuppressRoomEvents: 0x04, PublishUserId: 0x08,
  DeleteNullProps: 0x10, BroadcastPropsChangeToAll: 0x20,
};

export const CACHE = {
  DoNotCache: 0, MergeCache: 1, ReplaceCache: 2, RemoveCache: 3, AddToRoomCache: 4,
  AddToRoomCacheGlobal: 5, RemoveFromRoomCache: 6, RemoveFromRoomCacheForActorsLeft: 7,
};

export const RECEIVERS = { Others: 0, All: 1, MasterClient: 2 };

export const ERR = {
  Ok: 0,
  InternalServerError: -1,
  InvalidOperation: -2,
  OperationNotAllowedInCurrentState: -3,
  GameIdAlreadyExists: 32766,
  GameFull: 32765,
  GameClosed: 32764,
  NoRandomMatchFound: 32760,
  GameDoesNotExist: 32758,
  OperationLimitReached: 32743,
  JoinFailedWithRejoinerNotFound: 32748,
  JoinFailedFoundActiveJoiner: 32746,
};
