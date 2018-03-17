var test = require('tape');
var stateMachine = require('../../src/stateMachine/stateMachine');
var message = require('../../src/message');
var sjcl = require('sjcl-all');
var util = require('ethereumjs-util');

var privateKey =  util.toBuffer('0xe331b6d69882b4cb4ea581d88e0b604039a3de5967688d3dcffdd2270c0fd109');
var publicKey =util.privateToPublic(privateKey);
var address = util.pubToAddress(publicKey);
var channelAddress = address.toString("hex");

test('test messages', function(t){
  t.test('test initialize initiator',function  (assert) {
    var secret = "SECRET";
    var mediatedTransfer = new message.MediatedTransfer({nonce:new  util.BN(10),
      lock:{amount:new util.BN(100),expiration:new util.BN(20),hashLock:util.sha3(secret)},
      target:address,
      to:address
    });

    mediatedTransfer.sign(privateKey);

    debugger
    var receiveMediatedTransfer = new message.MediatedTransfer(JSON.parse(JSON.stringify(mediatedTransfer),message.JSON_REVIVER_FUNC));
    assert.equal(receiveMediatedTransfer.from.compare(mediatedTransfer.from),0);
    var mediatedTransferState = Object.assign({},mediatedTransfer,{secret:secret});
    stateMachine.Initiator.handle(mediatedTransferState,'init');

    //console.log(mediatedTransferState);
    var revealSecret = new message.RevealSecret({nonce:new  util.BN(10),secret:secret});
    revealSecret.sign(privateKey);
    var requestSecret = new message.RequestSecret({
      to:address,
      hashLock:util.sha3(secret)
    });

    try{
      stateMachine.Initiator.handle(mediatedTransferState,'receiveRequestSecret',requestSecret);
    }catch (e){

    }
    requestSecret.sign(privateKey);
    stateMachine.Initiator.handle(mediatedTransferState,'receiveRequestSecret',requestSecret);
    assert.equal(revealSecret.from.compare(address),0);
    stateMachine.Initiator.handle(mediatedTransferState,'receiveSecretReveal',revealSecret);
    console.log(mediatedTransferState);
    //stateMachine.Target.handle(receiveMediatedTransfer,'init');
    assert.end();
    // body...
  })
});