/*
* @Author: amitshah
* @Date:   2018-04-17 01:15:31
* @Last Modified by:   amitshah
* @Last Modified time: 2018-04-25 15:58:37
*/

const message = require('./message');
const channelState = require('./channelState');
const util = require('ethereumjs-util');

//Transfers apply state mutations to the channel object.  Once a transfer is verified
//we apply it to the Channel
const CHANNEL_STATE_IS_OPENING = 'opening';
const CHANNEL_STATE_IS_CLOSING = 'closing';
const CHANNEL_STATE_IS_SETTLING = 'settling';
const CHANNEL_STATE_CLOSED = 'closed';
const CHANNEL_STATE_OPEN = 'opened';
const CHANNEL_STATE_SETTLED = 'settled';

SETTLE_TIMEOUT = new util.BN(100);
//the minimum amount of time we need from the expiration of a lock to safely unlock
//this property should be negotiable by the users based on their level of conservantiveness
//in addition to expection of settled locks
REVEAL_TIMEOUT = new util.BN(15);

class Channel{

  constructor(peerState,myState,channelAddress,currentBlock){
    this.peerState = peerState; //channelState.ChannelStateSync
    this.myState = myState;//channelState.ChannelStateSync
    this.channelAddress = channelAddress || message.EMPTY_20BYTE_BUFFER;
    this.openedBlock = message.TO_BN(currentBlock);
    this.issuedCloseBlock = null;
    this.issuedTransferUpdateBlock = null;
    this.issuedSettleBlock = null;
    this.closedBlock = null;
    this.settledBlock = null;
    this.updatedProofBlock = null;
    this.withdrawnLocks = {};
  }


  //the amount of funds that can be sent from -> to in the payment channel
  transferrableFromTo(from,to,currentBlock){
    var safeBlock = null;
    if(currentBlock){
      safeBlock = currentBlock.add(REVEAL_TIMEOUT);
    }
    return from.depositBalance.
    sub((from.transferredAmount.add(from.lockedAmount(safeBlock)).add(from.unlockedAmount())))
    .add(to.transferredAmount.add(to.unlockedAmount()));
  }

  getChannelExpirationBlock(currentBlock){
    if(this.closedBlock){
      return this.closedBlock.add(SETTLE_TIMEOUT);
    }else{
      return currentBlock.add(SETTLE_TIMEOUT);
    }
  }

  get state(){
    if(this.settledBlock){
      return CHANNEL_STATE_SETTLED;
    }
    else if(this.issuedSettleBlock) {
      return CHANNEL_STATE_IS_SETTLING;
    }
    else if(this.closedBlock){
      return CHANNEL_STATE_CLOSED;
    }else if(this.issuedCloseBlock){
      return CHANNEL_STATE_IS_CLOSING;
    } else {
      return CHANNEL_STATE_OPEN;
    }
  }

  isOpen(){
    return this.state === CHANNEL_STATE_OPEN;
  }


  handleRevealSecret(revealSecret){
    if(!revealSecret instanceof message.RevealSecret){
      throw new Error("Invalid Message: Expected RevealSecret");
    };
    //TODO: we dont care where it comes from?
    //var from = null;
    // if(this.myState.address.compare(revealSecret.from)===0){
    //   from = this.myState;
    // }else if(this.peerState.address.compare(revealSecret.from)===0)
    // {
    //   from = this.peerState;
    // }
    // if(!from){throw new Error("Invalid RevealSecret: Unknown secret sent")};
    var myLock = this.myState.getLockFromSecret(revealSecret.secret);
    var peerLock = this.peerState.getLockFromSecret(revealSecret.secret);
    if(!myLock && !peerLock){
      throw new Error("Invalid Secret: Unknown secret revealed");
    }
    if(myLock){
      this.myState.applyRevealSecret(revealSecret);
    }

    if(peerLock){
      this.peerState.applyRevealSecret(revealSecret);
    }
    return true;

  }

  handleTransfer(transfer,currentBlock){
    //check the direction of data flow
    if(!this.isOpen()){
      throw new Error("Invalid transfer: cannot update a closing channel");
    }
    if(this.myState.address.compare(transfer.from) ==0){
      this.handleTransferFromTo(this.myState,this.peerState,transfer,currentBlock);
    }else if(this.peerState.address.compare(transfer.from) ==0){
      this.handleTransferFromTo(this.peerState,this.myState,transfer,currentBlock);
    }else{
      throw new Error("Invalid Transfer: unknown from");
    }

  }

  handleTransferFromTo(from,to,transfer,currentBlock){
    if(!transfer instanceof message.ProofMessage){
      throw new Error("Invalid Transfer Type");
    }

    var proof = transfer.toProof();
    if(proof.channelAddress.compare(this.channelAddress)!==0){
      throw new Error("Invalid Channel Address: channel address mismatch");
    }



    if(!proof.nonce.eq(from.nonce.add(new util.BN(1)))){
      throw new Error("Invalid nonce: Nonce must be incremented by 1");
    }

    //Validate LocksRoot

    if(transfer instanceof message.LockedTransfer){
      var lock = transfer.lock;
      if(from.containsLock(lock)){
        throw new Error("Invalid Lock: Lock registered previously");
      }
      var mtValidate = from._computeMerkleTreeWithHashlock(lock);
      if(mtValidate.getRoot().compare(proof.locksRoot)!==0){
        throw new Error("Invalid LocksRoot for LockedTransfer");
      }
      //validate lock as well
      if(lock.amount.lte(new util.BN(0))){
        throw new Error("Invalid Lock: Lock amount must be greater than 0");
      }



      //unfortunately we must handle all lock requests because then the state roots will
      //be unsynched.  What we can do instead is if the lock is outside our comfort zone
      //we simply dont make a RequestSecret to the initiator.  if we are in a mediated transfer
      //dont forward message, but alteast the locksRoots are synced

      // var expirationBlock = this.getChannelExpirationBlock(currentBlock);
      // //=  currentBlock.add(revealTimeout)<= expirationBlock <= currentBlock.add(SETTLE_TIMEOUT)
      // if(lock.expiration.lt(currentBlock.add(REVEAL_TIMEOUT)) || lock.expiration.gt(expirationBlock)){
      //   throw new Error("Invalid Lock Expiration: currentBlock+ this.REVEAL_TIMEOUT < Lock expiration < this.SETTLE_TIMEOUT ");
      // }

    }else if(transfer instanceof message.SecretToProof){
      //TODO: dont try to retreive the lock, just calculate the hash and send in
      //we do this twice thats why
      //If we have a secretToProof for an expired lock, we dont care, as long as
      //the lock exists we can take on the secretToProof
      var lock = from.getLockFromSecret(transfer.secret);
      if(!lock){
        throw new Error("Invalid SecretToProof: unknown secret");
      }
      var mtValidate = from._computeMerkleTreeWithoutHashlock(lock);
      if(mtValidate.getRoot().compare(proof.locksRoot)!==0){

        throw new Error("Invalid LocksRoot for SecretToProof:"+mtValidate.getRoot().toString('hex')+"!="+proof.locksRoot.toString('hex'));
      }
    }else if(from.merkleTree.getRoot().compare(proof.locksRoot) !==0){
      throw new Error("Invalid LocksRoot for Transfer");
    }

    //validate transferredAmount
    if(proof.transferredAmount.lt(from.transferredAmount)){
      throw new Error("Invalid transferredAmount: must be monotonically increasing value");
    }

    var transferrable = this.transferrableFromTo(from,to,currentBlock);
    if(transfer instanceof message.SecretToProof){
      var lock = from.getLockFromSecret(transfer.secret);//returns null if lock is not present
      if(!lock || (proof.transferredAmount.lt(from.transferredAmount.add(lock.amount)))){
        throw new Error("Invalid transferredAmount: SecretToProof does not provide expected lock amount");
      };
      //because we are removing the lock and adding it to transferred amount, we have access to the remaining funds
      //IMPORTANT CHECK, or else if we sent a lock transfer greater then our remaining balance, we could never unlock with a secret proof
      transferrable = transferrable.add(lock.amount);
    }
    //fix
    //if the sent delta between messages is greater than the total transferrable amount (i.e. net value flux)
    if(proof.transferredAmount.sub(from.transferredAmount).gt(transferrable)){
        throw new Error("Invalid transferredAmount: Insufficient Balance:"+proof.transferredAmount.toString()+" > "+transferrable.toString());
    }

   

    if(transfer instanceof message.LockedTransfer){
      from.applyLockedTransfer(transfer);
    }else if(transfer instanceof message.DirectTransfer){
      from.applyDirectTransfer(transfer);
    }if(transfer instanceof message.SecretToProof){
      from.applySecretToProof(transfer);
    }
    //validate all the values of a transfer prior to applying it to the StateSync

    return true;
  }

  incrementedNonce(){
    return this.myState.nonce.add(new util.BN(1));
  }

  //expirationBlock is the absolute blockNumber when the lock expires
  createLockedTransfer(msgID,hashLock,amount,expirationBlock,currentBlock){
    var transferrable = this.transferrableFromTo(this.myState,this.peerState,currentBlock);
    if(amount.lte(new util.BN(0)) || transferrable.lt(amount)){
      throw new Error("Insufficient funds: lock amount must be less than or equal to transferrable amount");
    }


    var lock = new message.Lock({amount:amount,expiration:expirationBlock, hashLock:hashLock})


    var lockedTransfer = new message.LockedTransfer({
      msgID:msgID,
      nonce: this.incrementedNonce(),
      channelAddress: this.channelAddress,
      transferredAmount:this.myState.transferredAmount,
      to:this.peerState.address,
      locksRoot:this.myState._computeMerkleTreeWithHashlock(lock).getRoot(),
      lock:lock
    });
    return lockedTransfer;
  }

  createDirectTransfer(msgID,transferredAmount){
    var transferrable = this.transferrableFromTo(this.myState, this.peerState);

    if(transferredAmount.lte(new util.BN(0)) ||
     transferredAmount.lte(this.myState.transferredAmount) ||
     transferredAmount.gt(transferrable)){

      throw new Error("Insufficient funds: direct transfer cannot be completed:"
        + transferredAmount.toString()+" - "+this.myState.transferredAmount.toString() +" > "
        + transferrable.toString(10));
    }

    var directTransfer = new message.DirectTransfer({
      msgID:msgID,
      nonce: this.incrementedNonce(),
      channelAddress: this.channelAddress,
      transferredAmount:transferredAmount,
      to:this.peerState.address,
      locksRoot:this.myState.merkleTree.getRoot()

    });
    return directTransfer;

  }

  createMediatedTransfer(msgID,hashLock,amount,expiration,target,initiator,currentBlock){
    var lockedTransfer = this.createLockedTransfer(msgID,hashLock,amount,expiration,currentBlock);
    var mediatedTransfer = new message.MediatedTransfer(
      Object.assign(
        {
          target:target,
          initiator:initiator
    },lockedTransfer));
    return mediatedTransfer;
  }

  createSecretToProof(msgID,secret){
    var lock = this.myState.getLockFromSecret(secret);
    if(!lock){
      console.log(Object.keys(this.myState.openLocks).map(function (l) {
        console.log("openLock:"+l);
      }));
      throw new Error("Invalid Secret: lock does not exist for secret:"+secret);
    }
    var mt = this.myState._computeMerkleTreeWithoutHashlock(lock);
    var transferredAmount = this.myState.transferredAmount.add(lock.amount);
    var secretToProof = new message.SecretToProof({
      msgID:msgID,
      nonce:this.incrementedNonce(),
      channelAddress: this.channelAddress,
      transferredAmount:transferredAmount,
      to:this.peerState.address,
      locksRoot:mt.getRoot(),
      secret:secret
    })
    return secretToProof;
  }

  //this function is only used for handling SETTLE
  //timeouts for locked transfers are handled by the statemachine atm
  //this will be refactored to make sure code locality
  onBlock(currentBlock){
    //we use to auto issue settle but now we leave it to the user.
    var events =[]
    if(this.canIssueSettle(currentBlock)){
        events.push(["GOT.issueSettle", this.channelAddress]);
    }
    return events;
    // var earliestLockExpiration = this.peerState.minOpenLockExpiration;
    // if(earliestLockExpiration.sub(revealTimeout).gte(currentBlock)){
    //   this.handleClose(this.myState.address,currentBlock);
    //   return false;//We have to close this channel
    // }

  }  
  
  canIssueSettle(currentBlock){
    return (this.closedBlock &&
      currentBlock.gt(this.closedBlock.add(SETTLE_TIMEOUT)));
  }

  issueSettle(currentBlock){
   if(this.canIssueSettle(currentBlock)){
        this.issuedSettleBlock = currentBlock;
    }
   return this.issuedSettleBlock;
  }

  issueClose(currentBlock){
    if(!this.issuedCloseBlock && !this.closedBlock){

      this.issuedCloseBlock = currentBlock;
      
      return this.peerState.proof.signature ? this.peerState.proof : null;
    }
    throw new Error("Channel Error: In Closing State or Is Closed");
  }

  issueTransferUpdate(currentBlock){
    if(!this.issuedCloseBlock){
      this.issuedTransferUpdateBlock = currentBlock;
      return this.peerState.proof.signature ? this.peerState.proof : null;
    }
  }

  issueWithdrawPeerOpenLocks(currentBlock){
    var openLockProofs = this._withdrawPeerOpenLocks();
    for(var i=0; i < openLockProofs.length; i++){
        var openLock = openLockProofs[i].openLock;
        var hashKey = util.addHexPrefix(openLock.hashLock.toString('hex'));
        this.withdrawnLocks[hashKey] = currentBlock;
    }   
    
    return openLockProofs;
  }

  //withdraw all peerstate locks
  _withdrawPeerOpenLocks(){
    //withdraw all open locks
    var self = this;
    var lockProofs = Object.values(this.peerState.openLocks).map(function  (lock) {
      try{
        return new OpenLockProof({"openLock":lock,"merkleProof":self.peerState.generateLockProof(lock)});
      }catch(err){
        console.log(err);
        return;
      }
    });
    return lockProofs;
  }
  
  onChannelNewBalance(address,balance){
    if(this.myState.address.compare(address) === 0){
      this._handleDepositFrom(this.myState,balance);
    }else if(this.peerState.address.compare(address)===0){
      this._handleDepositFrom(this.peerState,balance);
    }
  }

   _handleDepositFrom(from, depositAmount){
    //deposit amount must be monotonically increasing
    if(from.depositBalance.lt(depositAmount)){
      from.depositBalance = depositAmount;
    }else{
      throw new Error("Invalid Deposit Amount: deposit must be monotonically increasing");
    }
  }

  onChannelClose(closingAddress,block){
    this.closedBlock = block;
  }

  onChannelCloseError(){
    if(!this.closedBlock){
      this.issuedCloseBlock = null;
      this.closedBlock = null;
    }
  }

  onTransferUpdated(nodeAddress,block){
    this.updatedProofBlock = block;
  }

  onTransferUpdatedError(){
    if(!this.updatedProofBlock){
      this.issuedTransferUpdateBlock = null;
      this.updatedProofBlock = null;
    }
  }

  onChannelSettled(block){
    this.settledBlock = block;
  }

  onChannelSettledError(){
    if(!this.settledBlock){
      this.settledBlock = null;
      this.issuedSettleBlock = null;
    }
  }

  onChannelSecretRevealed(secret,receiverAddress,block){
    var hashKey = util.addHexPrefix((util.sha3(secret)).toString('hex'));
    this.withdrawnLocks[hashKey] = block;     
  };

  onChannelSecretRevealedError(secret){
    var hashKey = util.addHexPrefix((util.sha3(secret)).toString('hex'));
    this.withdrawnLocks[hashKey] = null;    
  };

  onRefund(receiverAddress, amount){

  }

}

class OpenLockProof{
  constructor(options){
    this.openLock = options.openLock;
    this.merkleProof = options.merkleProof;
  }

  encodeLock(){
    //we dont want the secret appended to this encoding
    return this.openLock.encode().slice(0,96);
  }
}

module.exports = {
  Channel,SETTLE_TIMEOUT,REVEAL_TIMEOUT,CHANNEL_STATE_IS_CLOSING,CHANNEL_STATE_IS_SETTLING, CHANNEL_STATE_IS_OPENING,
  CHANNEL_STATE_OPEN, CHANNEL_STATE_CLOSED, CHANNEL_STATE_SETTLED,OpenLockProof
}

