//
// Wallets Object
// BitGo accessor to a user's wallets.
//
// Copyright 2014, BitGo, Inc.  All Rights Reserved.
//

var request = require('superagent');
var ECKey = require('./bitcoin/eckey');
var Wallet = require('./wallet');
var common = require('./common');
var BIP32 = require('./bitcoin/bip32');
var Q = require('q');

//
// Constructor
//
var Wallets = function(bitgo) {
  this.bitgo = bitgo;
};

//
// list
// List the user's wallets
//
Wallets.prototype.list = function(params, callback) {
  params = params || {};
  common.validateParams(params, [], [], callback);

  var self = this;
  return this.bitgo.get(this.bitgo.url('/wallet'))
  .result()
  .then(function(body) {
    var wallets = {};
    for (var wallet in body.wallets) {
      wallets[wallet] = new Wallet(self.bitgo, body.wallets[wallet]);
    }
    return wallets;
  })
  .nodeify(callback);
};

//
// listShares
// List the user's wallet shares
//
Wallets.prototype.listShares = function(params, callback) {
  params = params || {};
  common.validateParams(params, [], [], callback);

  var self = this;
  return this.bitgo.get(this.bitgo.url('/walletshare'))
  .result()
  .nodeify(callback);
};

//
// getShare
// Gets a wallet share information, including the encrypted sharing keychain. requires unlock if keychain is present.
// Params:
//    walletShareId - the wallet share to get informatoin on
//
Wallets.prototype.getShare = function(params, callback) {
  params = params || {};
  common.validateParams(params, ['walletShareId'], [], callback);

  var self = this;
  return this.bitgo.get(this.bitgo.url('/walletshare/' + params.walletShareId))
  .result()
  .nodeify(callback);
};


//
// acceptShare
// Accepts a wallet share, adding the wallet to the user's list
// Needs a user's password to decrypt the shared key
// Params:
//    walletShareId - the wallet share to accept
//    userPassword - (required if more than view permissions are shared) user's password to decrypt the shared wallet
//    newWalletPassphrase - new wallet passphrase for saving the shared wallet xprv.
//                          If left blank and a wallet with more than view permissions was shared, then the userpassword is used.
//
Wallets.prototype.acceptShare = function(params, callback) {
  params = params || {};
  common.validateParams(params, ['walletShareId'], [], callback);

  var self = this;
  var encryptedSharedWalletXprv;

  return this.getShare({walletShareId: params.walletShareId})
  .then(function(walletShare) {
    var permissions = walletShare.permissions.split(",");
    if (permissions.length === 1 && permissions.indexOf("view") >= 0) {
      // Only the view permission was needed, so just return the wallet share for acceptance
      return walletShare;
    }

    // More than viewing was requested, so we need to process the wallet keys using the shared ecdh scheme
    if (!params.userPassword) {
      throw new Error("userPassword param must be provided to decrypt shared key");
    }

    return self.bitgo.getECDHSharingKeychain()
    .then(function(sharingKeychain) {
      if (!sharingKeychain.encryptedXprv) {
        throw new Error('EncryptedXprv was not found on sharing keychain')
      }

      // Now we have the sharing keychain, we can work out the secret used for sharing the wallet with us
      sharingKeychain.xprv = self.bitgo.decrypt({ password: params.userPassword, input: sharingKeychain.encryptedXprv });
      var rootExtKey = new BIP32(sharingKeychain.xprv);
      // Derive key by path (which is used between these 2 users only)
      var extKey = rootExtKey.derive(walletShare.keychain.path);
      var secret = self.bitgo.getECDHSecret({ eckey: extKey.eckey, otherPubKeyHex: walletShare.keychain.fromPubKey });

      // Yes! We got the secret successfully here, now decrypt the shared wallet xprv
      var decryptedSharedWalletXprv = self.bitgo.decrypt({ password: secret, input: walletShare.keychain.encryptedXprv });

      // We will now re-encrypt the wallet with our own password
      var newWalletPassphrase = params.newWalletPassphrase || params.userPassword;
      encryptedSharedWalletXprv = self.bitgo.encrypt({ password: newWalletPassphrase, input: decryptedSharedWalletXprv });

      // Carry on to the next block where we will post the acceptance of the share with the encrypted xprv
      return walletShare;
    });
  })
  .then(function(walletShare) {
    var postBody = {
      'state': 'accepted'
    };

    if (encryptedSharedWalletXprv) {
      postBody.encryptedXprv = encryptedSharedWalletXprv;
    }

    return self.bitgo.post(self.bitgo.url('/walletshare/' + params.walletShareId))
    .send(postBody)
    .result()
    .then(function(res) {
      return res;
    });
  })
  .nodeify(callback);
};

//
// createKey
// Create a single bitcoin key.  This runs locally.
// Returns: {
//   address: <address>
//   key: <key, in WIF format>
// }
Wallets.prototype.createKey = function(params) {
  params = params || {};
  common.validateParams(params);

  var key = new ECKey();
  return {
    address: key.getBitcoinAddress(),
    key: key.getWalletImportFormat()
  };
};

//
// createWalletWithKeychains
// Create a new 2-of-3 wallet and it's associated keychains.
// Returns the locally created keys with their encrypted xprvs.
// **WARNING: BE SURE TO BACKUP! NOT DOING SO CAN RESULT IN LOSS OF FUNDS!**
//
// 1. Creates the user keychain locally on the client, and encrypts it with the provided passphrase
// 2. If no xpub was provided, creates the backup keychain locally on the client, and encrypts it with the provided passphrase
// 3. Uploads the encrypted user and backup keychains to BitGo
// 4. Creates the BitGo key on the service
// 5. Creates the wallet on BitGo with the 3 public keys above
//
// Parameters include:
//   "passphrase": wallet passphrase to encrypt user and backup keys with
//   "label": wallet label, is shown in BitGo UI
//   "backupXpub": backup keychain xpub, it is HIGHLY RECOMMENDED you generate this on a separate machine!
//                 BITGO DOES NOT GUARANTEE SAFETY OF WALLETS WITH MULTIPLE KEYS CREATED ON THE SAME MACHINE **
// Returns: {
//   wallet: newly created wallet model object
//   userKeychain: the newly created user keychain, which has an encrypted xprv stored on BitGo
//   backupKeychain: the newly created backup keychain
//
// ** BE SURE TO BACK UP THE ENCRYPTED USER AND BACKUP KEYCHAINS!**
//
// }
Wallets.prototype.createWalletWithKeychains = function(params, callback) {
  params = params || {};
  common.validateParams(params, ['passphrase'], ['label', 'backupXpub', 'enterprise'], callback);

  var self = this;
  var label = params.label;

  // Create the user and backup key.
  var userKeychain = this.bitgo.keychains().create();
  userKeychain.encryptedXprv = this.bitgo.encrypt({ password: params.passphrase, input: userKeychain.xprv });

  var backupKeychain = { "xpub" : params.backupXpub };
  if (!params.backupXpub) {
    backupKeychain = this.bitgo.keychains().create();
  }

  var bitgoKeychain;

  // Add keychains to BitGo
  var key1Params = {
    "xpub": userKeychain.xpub,
    "encryptedXprv": userKeychain.encryptedXprv
  };

  return self.bitgo.keychains().add(key1Params)
  .then(function(keychain) {
    var key2Params = {
      "xpub": backupKeychain.xpub
    };
    return self.bitgo.keychains().add(key2Params);
  })
  .then(function(keychain) {
    return self.bitgo.keychains().createBitGo();
  })
  .then(function(keychain) {
    bitgoKeychain = keychain;
    var walletParams = {
      "label": label,
      "m": 2,
      "n": 3,
      "keychains": [
        { "xpub": userKeychain.xpub },
        { "xpub": backupKeychain.xpub },
        { "xpub": bitgoKeychain.xpub} ]
    };

    if (params.enterprise) {
      walletParams.enterprise = params.enterprise;
    }

    return self.add(walletParams);
  })
  .then(function(result) {
    return {
      wallet: result,
      userKeychain: userKeychain,
      backupKeychain: backupKeychain,
      bitgoKeychain: bitgoKeychain,
      warning: 'Be sure to backup the backup keychain -- it is not stored anywhere else!'
    };
  })
  .nodeify(callback);
};

//
// add
// Add a new wallet (advanced mode).
// This allows you to manually submit the keychains, type, m and n of the wallet
// Parameters include:
//    "label": label of the wallet to be shown in UI
//    "m": number of keys required to unlock wallet (2)
//    "n": number of keys available on the wallet (3)
//    "keychains": array of keychain xpubs
Wallets.prototype.add = function(params, callback) {
  params = params || {};
  common.validateParams(params, [], ['label', 'enterprise'], callback);

  if (Array.isArray(params.keychains) === false || typeof(params.m) !== 'number' ||
    typeof(params.n) != 'number') {
    throw new Error('invalid argument');
  }

  // TODO: support more types of multisig
  if (params.m != 2 || params.n != 3) {
    throw new Error('unsupported multi-sig type');
  }

  var self = this;
  var keychains = params.keychains.map(function(k) { return {xpub: k.xpub}; });
  var walletParams = {
    label: params.label,
    m: params.m,
    n: params.n,
    keychains: keychains
  };

  if (params.enterprise) {
    walletParams.enterprise = params.enterprise;
  }

  return this.bitgo.post(this.bitgo.url('/wallet'))
  .send(walletParams)
  .result()
  .then(function(body) {
    return new Wallet(self.bitgo, body);
  })
  .nodeify(callback);
};

//
// get
// Fetch an existing wallet
// Parameters include:
//   address: the address of the wallet
//
Wallets.prototype.get = function(params, callback) {
  params = params || {};
  common.validateParams(params, ['id'], [], callback);

  var self = this;
  return this.bitgo.get(this.bitgo.url('/wallet/' + params.id))
  .result()
  .then(function(body) {
    return new Wallet(self.bitgo, body);
  })
  .nodeify(callback);
};

module.exports = Wallets;
