var express = require('express')
var app = express();
const bodyParser = require('body-parser');
const Blockchain = require('./blockchain');
const uuid = require('uuid/v1');
const port = process.argv[2];
const rp = require('request-promise');

const nodeAddress = uuid().split('-').join('');

const chain = new Blockchain();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
 
app.get('/blockchain', function(req, res){
    res.send(chain);

});

app.post('/transaction', function(req, res){
    const newTransaction = req.body;
    const blockIndex = chain.addTransactionToPendingTransaction(newTransaction);
    res.json({ note: ` Transaction will be created in block ${blockIndex}.`});

});

app.post('/transaction/broadcast', function(req, res){
    const newTransaction = chain.createNewTransaction(req.body.amount, req.body.sender, req.body.recipient);
    chain.addTransactionToPendingTransaction(newTransaction);

    const requestPromises =[];
    chain.networkNodes.forEach(networkNodeUrl =>{
        const  requestOptions = {
            uri: networkNodeUrl + '/transaction',
            method : 'POST',
            body:newTransaction,
            json: true
        };
        requestPromises.push(rp(requestOptions));
    });

    Promise.all(requestPromises)
    .then(data =>{
        res.json({note: ' Transaction created and broadcast successfully'});
    });
});

app.get('/mine', function(req, res){
    const lastBlock = chain.getLastBlock();
    const previousBlockHash = lastBlock['hash'];
    
    const currentBlockData = {
        transactions: chain.pendingTransactions,
        index: lastBlock['index'] + 1
    }

    const nonce = chain.proofOfWork(previousBlockHash, currentBlockData);
    const blockHash = chain.hashBlock(previousBlockHash, currentBlockData, nonce);

    const newBlock = chain.createNewBlock(nonce, previousBlockHash, blockHash);

    const requestPromises = [];
	chain.networkNodes.forEach(networkNodeUrl => {
		const requestOptions = {
			uri: networkNodeUrl + '/receive-new-block',
			method: 'POST',
			body: { newBlock: newBlock },
			json: true
		};

		requestPromises.push(rp(requestOptions));
	});

	Promise.all(requestPromises)
	.then(data => {
		const requestOptions = {
			uri: chain.currentNodeUrl + '/transaction/broadcast',
			method: 'POST',
			body: {
				amount: 12.5,
				sender: "00",
				recipient: nodeAddress
			},
			json: true
		};

		return rp(requestOptions);
	})
	.then(data => {
		res.json({
			note: "New block mined & broadcast successfully",
			block: newBlock
		});
	});
});


// receive new block
app.post('/receive-new-block', function(req, res) {
	const newBlock = req.body.newBlock;
	const lastBlock = chain.getLastBlock();
	const correctHash = lastBlock.hash === newBlock.previousBlockHash; 
	const correctIndex = lastBlock['index'] + 1 === newBlock['index'];

	if (correctHash && correctIndex) {
		chain.chain.push(newBlock);
		chain.pendingTransactions = [];
		res.json({
			note: 'New block received and accepted.',
			newBlock: newBlock
		});
	} else {
		res.json({
			note: 'New block rejected.',
			newBlock: newBlock
		});
	}
});



// register a node and broadcase it the network
app.post('/register-and-broadcast-node', function(req, res){
    const newNodeUrl =  req.body.newNodeUrl;
    if(chain.networkNodes.indexOf(newNodeUrl) == -1)
        chain.networkNodes.push(newNodeUrl);

    const regNodesPromises = [];
    chain.networkNodes.forEach(networkNodeUrl =>{
        const requestOptions = {
            uri: networkNodeUrl+ '/register-node',
            method: 'POST',
            body :{newNodeUrl: newNodeUrl},
            json: true
        };

        regNodesPromises.push(rp(requestOptions));
    });

    Promise.all(regNodesPromises)
    .then(data =>{
        // use the data

        const bulkRegisterOptions = {
            uri : newNodeUrl + '/register-nodes-bulk',
            method: 'POST',
            body : { allNetworkNodes :[ ...chain.networkNodes, chain.currentNodeUrl]},
            json: true
        }
        return rp(bulkRegisterOptions);
    })
    .then(data =>{
        res.json({ note : 'New node registered with network successfully.'});
    });
});

// register a node with the network
app.post('/register-node', function(req, res){
    const newNodeUrl = req.body.newNodeUrl;
    const nodeNotAlreadyPresent = chain.networkNodes.indexOf(newNodeUrl) == -1;
    const notCurrentNode = chain.currentNodeUrl !== newNodeUrl;
    if(nodeNotAlreadyPresent && notCurrentNode) 
        chain.networkNodes.push(newNodeUrl);
    res.json({note:'New node registered successfully with node'});
});

//register multiple nodes at once. 
app.post('/register-nodes-bulk', function(req, res){ 
    const allNetworkNodes = req.body.allNetworkNodes;
    allNetworkNodes.forEach(networkNodeUrl =>{
        const nodeNotAlreadyPresent = chain.networkNodes.indexOf(networkNodeUrl) == -1;
        const notCurrentNode = chain.currentNodeUrl !== networkNodeUrl;
        if(nodeNotAlreadyPresent && notCurrentNode) 
            chain.networkNodes.push(networkNodeUrl);
    });

    res.json({note: 'Bulk registeration successful.'});
});

app.get('/consensus', function(req, res){
  
    const requestPromises =[];
    chain.networkNodes.forEach(networkNodeUrl =>{
        const requestOptions = {
            uri : networkNodeUrl + '/blockchain',
            method: 'GET',
            json: true
        };

        requestPromises.push(rp(requestOptions));
    });

    Promise.all(requestPromises)
    .then(blockchains =>{
        const currentChainLength = chain.chain.length;
        let maxChainLength = currentChainLength;
        let newLongesChain = null;
        let newPendingTransactions = null;

        blockchains.forEach(blockchain =>{
            if(blockchain.chain.length > maxChainLength)
            {
                maxChainLength = blockchain.chain.length;
                newLongesChain = blockchain.chain;
                newPendingTransactions = blockchain.pendingTransactions;
            };
        });

        if(!newLongesChain || (newLongesChain && !chain.chainIsValid(newLongesChain)))
        {
            res.json({
                note: 'Current chain has not been replaced.',
                chain: chain.chain
            });
        }
        else if(newLongesChain&& chain.chainIsValid(newLongesChain))
        {
            chain.chain = newLongesChain;
            chain.pendingTransactions = newPendingTransactions;
            res.json({
                note:'This chain has been replaced.',
                chain: chain.chain
            });

        }
    });
});


app.get('/block/:blockHash', function(req, res){
    const blockHash = req.params.blockHash;
    const correctBlock = chain.getBlock(blockHash);
    res.json({
        block: correctBlock
    });
});

app.get('/transaction/:transactionId', function(req, res){
    const transactionId = req.params.transactionId;
    const transactionData = chain.getTransaction(transactionId);
    res.json({
        transaction: transactionData.transaction,
        block: transactionData.block
    });
});

app.get('/address/:address', function(req, res){
    const address = req.params.address;
    const addressData = chain.getAddressData(address);
    res.json({
        addressData: addressData
    });
});

 
app.listen(port, function(){
    console.log(`Listening on port ${port} ...`);
});