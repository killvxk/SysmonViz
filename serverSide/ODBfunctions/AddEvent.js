  /**
   * 1. Use ODB WebStudio Function Management (FM)
   * 2. Create a function AddEvent with two parameters: classname, jsondata
   * 3. Paste the codes below into the FM's editor & save  
   */
  var db = orient.getDatabase();
  
  // edge class look up table to minimize repeated queries; vertex-class to edge-class
  var edgeLookup = {'ProcessTerminate':'Terminated', 'PipeCreated':'CreatedPipe',
                    'PipeConnected':'ConnectedPipe', 'RawAccessRead':'RawRead',
                    'FileCreateTime':'ChangedFileCreateTime', 'FileCreate':'CreatedFile',
                    'FileCreateStreamHash':'CreatedFileStream', 'RegistryEvent':'AccessedRegistry',
                    'NetworkConnect':'ConnectedTo', 'ImageLoad':'LoadedImage'}
  
  // EventId to Classname
  var eventIdLookup = {1:'ProcessCreate', 2:'FileCreateTime', 3:'NetworkConnect', 
                        4:'SysmonStatus', 5:'ProcessTerminate',6:'DriverLoad', 
                        7:'ImageLoad', 8:'CreateRemoteThread', 9:'RawAccessRead', 
                        10:'ProcessAccess', 11:'FileCreate', 12:'RegistryEvent', 
                        13:'RegistryEvent', 14:'RegistryEvent', 15:'FileCreateStreamHash', 
                        16:'ConfigChanged', 17:'PipeCreated', 18:'PipeConnected', 
                        19:'WmiEvent', 20:'WmiEvent', 21:'WmiEvent', 255:'Error' }
  
  // fix issue #104 - illegal field names
  function rewriteProperties(obj) {
    var notValid = /[\W_]+/g
    if (typeof obj !== "object") return obj; //that is not a typo, it checks value & type
    for (var prop in obj) {
        if (obj.hasOwnProperty(prop)) {
            obj[prop.replace(notValid, "")] = rewriteProperties(obj[prop]);
            if (notValid.test(prop)) {
                delete obj[prop];
            }
        }
    }
    return obj;
  }                       
  
  function retry(command){
  	try {
      eval(command) 
    }
    catch(err){
      var e = '' + err
      if(e.indexOf('UPDATE') > 0) {
	      print('Retrying ' + command)
    	  retry(command)
      }
    }
  }

  var logline = unescape(jsondata)
  try {
    var e = rewriteProperties(JSON.parse(logline)); 
  }
  catch(err) {
      print(Date() + ' Offending line ' + logline);
      return
  }
  
  e['ToBeProcessed'] = true
  classname = 'WinEvent'
  
  if(e['Keywords'] != undefined) {
  	e['Keywords'] = '' + e['Keywords']
  }

  // Sysmon events
  if(e["SourceName"] == "Microsoft-Windows-Sysmon"){
      classname = eventIdLookup[e['EventID']]
      e['SysmonProcessId'] = e['ProcessID']
      delete e['ProcessID']
      var re = /ProcessId: (\d+)/g
      var match = re.exec(e['Message'])
      if(match != null)
          e['ProcessId'] = parseInt(match[1])        
  }

  // DataFusion UAT events
  if(e["SourceName"] == "DataFuseUserActions"){
      classname = 'UserActionTracking'
      delete e['ProcessID']
      try {
        var uat = JSON.parse(e['Message'])
      }
      catch(err) {
        print(Date() + ' Offending DataFuseUserActions ' + e['Message'])
        print(logline)
      }
      for(var k in uat){
          e[k] = uat[k]
      }
  }

  // DataFusion network events
  if(e["SourceName"] == "DataFuseNetwork"){
      classname = 'NetworkDetails'
      delete e['ProcessID']
      try {
      	var uat = JSON.parse(e['Message'])
      }
      catch(err){
      	print(Date() + ' Offending DataFuseNetwork ' + e['Message'])
      }
      for(var k in uat){
          e[k] = uat[k]
      }
  }   

  delete e['Message'] //problematic for server-side parsing... it is repeated data anyway
  var jsonstring = JSON.stringify(e)
  var id = (new Date())*1
  jsonstring = jsonstring.slice(0,-1) + ",\"id\":" + id + '}'
  var stmt = 'INSERT INTO '+ classname + ' CONTENT ' + jsonstring
  if(classname != 'ImageLoad') {
     try {
        var r = db.command(stmt);
     }
     catch(err){
       print(Date() + ' Error inserting ' + stmt)
     }
  }
  //print(Date() + classname);
  switch(classname) {
    case "ProcessCreate":
      		var current_id = r[0].getProperty('id')
      		// update SMSS.exe ID into cache table to find Type A process
      		print(Date() + " AddEvent for " + classname + " " + e['Image'] + ':' + e['ProcessGuid'] + " on " + e['Hostname'])
      		if(e['ParentImage'] == "System") {// smss.exe
                print(Date() + " Found " + e['Image'] + " on " + e['Hostname'])
                db.command('UPDATE TypeA_id_cache SET smss_id = ? UPSERT \
							WHERE Hostname = ?',r[0].getProperty('id'),e['Hostname'])
            }
      		// update explorer.exe ID into cache table  to find Type A process      
            if(e['ParentImage'].indexOf("Windows\\System32\\userinit.exe") > 0) {// explorer.exe
               print(Date() + " Found " + e['Image'] + " on " + e['Hostname'])
               db.command('UPDATE TypeA_id_cache SET explorer_id = ? UPSERT \
						   WHERE Hostname = ?',r[0].getProperty('id'),e['Hostname'])
            }
      		// ImageHashes tracking
      		var u = db.command('UPDATE ImageHashes set Image = ?, Hashes = ?, Count = Count + 1 \
								UPSERT RETURN AFTER @rid, Count WHERE Image = ? AND Hashes = ?',
                       			e['Image'],e['Hashes'],e['Image'],e['Hashes'])
            u = db.command('UPDATE ImageHashes set HashCount = HashCount + 1 \
							RETURN AFTER @rid, Count, HashCount WHERE Hashes = ?',e['Hashes'])

      		var IHT_rid = u[0].getProperty('@rid')
      		if(u[0].getProperty('HashCount') == 1) 
            {
                print()
              	print(Date() + " EXE first-sighting of " + e['Image'])
                print('Link ' + u[0].getProperty('@rid') + ' to ' + r[0].getProperty('@rid'))
              	retry("db.command('CREATE EDGE ExeSighted FROM ? TO ?',u[0].getProperty('@rid'),r[0].getProperty('@rid'))")
                print()
                // find any FileCreate that can be link to this sighting
              	db.command('INSERT INTO Watchlist SET Hostname = ?, ProcessGuid = ?',r[0].getProperty('Hostname'),r[0].getProperty('ProcessGuid'))
                print('Added to watchlist: ' + r[0].getProperty('Hostname') + ' ' +  r[0].getProperty('ProcessGuid'))
            }
      		// CommandLine tracking
      		u = db.command('UPDATE HostUserPrivilegeCommandLine set Count = Count + 1 \
							UPSERT RETURN AFTER @rid, Count WHERE \
							Hostname = ? AND User = ? AND CommandLine = ? AND IntegrityLevel = ?'
                           ,e['Hostname'],e['User'],e['CommandLine'],e['IntegrityLevel'])
      
		    var HUPC_rid = u[0].getProperty('@rid')
      		if(u[0].getProperty('Count') == 1) {
            	 print()
                 print(Date() + " CommandLine first-sighting of " + e['CommandLine'] + ' on ' + e['Hostname'])
              	 retry("db.command('CREATE EDGE CommandLineSighted FROM ? TO ?',u[0].getProperty('@rid'),r[0].getProperty('@rid'))")
              	 retry("db.command('CREATE EDGE HasHashes FROM ? to ?', HUPC_rid, IHT_rid)")
                 // find any FileCreate that can be link to this sighting
              	 db.command('INSERT INTO Watchlist SET Hostname = ?, ProcessGuid = ?',r[0].getProperty('Hostname'),r[0].getProperty('ProcessGuid'))
                 print('Added to watchlist: ' + r[0].getProperty('Hostname') + ' ' +  r[0].getProperty('ProcessGuid'))
            }
      
      		// Check Process Type 
      		var t = db.query('select from TypeA_id_cache')
      		if(current_id > t[0].getProperty('smss_id') && current_id > t[0].getProperty('explorer_id') 
               && t[0].getProperty('explorer_id') > t[0].getProperty('smss_id')) {
            	print(' Created PendingType for ' + r[0].getProperty('@rid'))
              	retry("db.command('CREATE EDGE PendingType from ? TO ?',HUPC_rid, r[0].getProperty('@rid'))")
            }
      		else {
              	print('ProcessType: BeforeExplorer')
              	retry("db.command('UPDATE ? SET ProcessType = ?', HUPC_rid,'BeforeExplorer')")
              	retry("db.command('UPDATE ? SET ProcessType = ?', r[0].getProperty('@rid'),'BeforeExplorer')")
            }
      		print('')
            break;
      
    case "ImageLoad": 
      	  // track Full-path vs Hashes
      	  var u = db.command('UPDATE ImageLoadedHashes set ImageLoaded = ?, Hashes = ?, Count = Count + 1 \
						UPSERT RETURN AFTER @rid, Count WHERE ImageLoaded = ? AND Hashes = ?',
                       e['ImageLoaded'],e['Hashes'],e['ImageLoaded'],e['Hashes'])
          
          // track ONLY Hashes
          u = db.command('UPDATE ImageLoadedHashes set HashCount = HashCount + 1 \
						UPSERT RETURN AFTER @rid, HashCount WHERE Hashes = ?',e['Hashes'])
          
          if(u[0].getProperty('HashCount') == 1) {
              var r = db.command(stmt); // insert the ImageLoad log line
              print(Date() + " Dll First Sighting of " + e['ImageLoaded'])
              retry("db.command('CREATE EDGE DllSighted from ? TO ?', u[0].getProperty('@rid'), r[0].getProperty('@rid'))")
              retry("db.command('CREATE EDGE UsedAsImage FROM (SELECT FROM FileCreate WHERE Hostname = ? AND TargetFilename in (SELECT ImageLoaded FROM ?) order by id desc limit 1) TO ?',e['Hostname'], r[0].getProperty('@rid') ,r[0].getProperty('@rid'))")
              print(Date() + " Linked First Sighted Dll to " + r[0].getProperty('@rid'))      
              
              db.command('INSERT INTO Watchlist SET Hostname = ?, ProcessGuid = ?',r[0].getProperty('Hostname'),r[0].getProperty('ProcessGuid'))
              print('Added to watchlist: ' + r[0].getProperty('Hostname') + ' ' +  r[0].getProperty('ProcessGuid'))
          }//*/
      	  break;
      
    case "DriverLoad": //ID6
      	  var u = db.command('UPDATE ImageLoadedHashes set ImageLoaded = ?, Hashes = ?, Count = Count + 1 \
						UPSERT RETURN AFTER @rid, Count WHERE ImageLoaded = ? AND Hashes = ?',
                       e['ImageLoaded'],e['Hashes'],e['ImageLoaded'],e['Hashes'])
          
          if(u[0].getProperty('Count') == 1) {
            	print(Date() + "Sys First Sighting of " + e['ImageLoaded'])
            	retry("db.command('CREATE EDGE SysSighted from ? TO ?', u[0].getProperty('@rid'), r[0].getProperty('@rid'))")
            	retry("db.command('CREATE EDGE UsedAsDriver FROM (SELECT FROM FileCreate WHERE Hostname = ? AND TargetFilename in (SELECT ImageLoaded FROM ?) order by id desc limit 1) TO ?',e['Hostname'],r[0].getProperty('@rid'),r[0].getProperty('@rid'))")
          }
      	  break;

    case "CreateRemoteThread": //ID8
         print('handling CreateRemoteThread ' + e['TargetProcessGuid'] + ' ' + e['Hostname'])
         // CreateRemoteThread-[RemoteThreadFor:TargetProcessGuid]->ProcessCreate
      	 var target = db.query('SELECT FROM (SELECT FROM ProcessCreate WHERE ProcessGuid = ?) WHERE Hostname = ?', e['TargetProcessGuid'],e['Hostname']);
         if(target.length > 0) {
            print('Found ' +  target[0].getProperty('@rid'));
         	db.command('CREATE EDGE RemoteThreadFor FROM ? TO ?', r[0].getProperty('@rid'), target[0].getProperty('@rid'));
         	print('Done RemoteThreadFor')
         }      
         // ProcessCreate-[CreatedThread:SourceProcessGuid]->CreateRemoteThread
		 db.command('CREATE EDGE CreatedThread FROM (SELECT FROM (SELECT FROM ProcessCreate WHERE ProcessGuid = ?) WHERE Hostname = ?) TO ?',e['SourceProcessGuid'],e['Hostname'],r[0].getProperty('@rid'))
         print('Done CreatedThread')
         break;
           
		// shifted to LinkUAT, which is called by handleUserActions.js
/*    case 'UserActionTracking':
          break;
      
          //print(Date() + ' Start UAT Processing')
          if(e['Action']=='Foreground Transition'){ 
              retry("db.command('CREATE EDGE SwitchedFrom FROM (SELECT FROM ProcessCreate WHERE ProcessId = ? AND Hostname = ? Order By id Desc Limit 1) TO ?',e['FromProcessId'],e['Hostname'],r[0].getProperty('@rid'))")
              
             //print('Linking SwitchedTo for ' + e['ToProcessId'])
             retry("db.command('CREATE EDGE SwitchedTo FROM ? TO (SELECT FROM ProcessCreate WHERE ProcessId = ? AND Hostname = ? Order By id Desc  LIMIT 1)',r[0].getProperty('@rid'),e['ToProcessId'],e['Hostname'])")
             
          }
          else { // other UAT actions
              var pc = db.query('SELECT FROM ProcessCreate \
					   WHERE Hostname = ? AND ProcessId = ? Order By id Desc LIMIT 1',e['Hostname'],e['ProcessId'])
              if(pc.length == 0) return //means somehow ProcessCreate was missing.
            
              print('Linking ' + e['Action'] + ' to ' + pc[0].getProperty('@rid') + ' ' + pc[0].getProperty('CommandLine') + ' ' + e['ProcessId'])
              retry("db.command('CREATE EDGE ActedOn FROM ? TO ?',r[0].getProperty('@rid'),pc[0].getProperty('@rid'))")
              
              // handle PendingType
              if(e['Action'].indexOf('Click') > 0 || e['Action'].indexOf('Press')) {
                  var checkPendingType = '' + pc[0]
                  if(checkPendingType.indexOf('in_PendingType:[]') < 0 && checkPendingType.indexOf('in_PendingType') > 0){
                  		retry("db.command('UPDATE ? SET ProcessType = ?', pc[0].getProperty('@rid'),'AfterExplorerForeground')")
                        print("Set ProcessType to AfterExplorerFG for " + pc[0].getProperty('CommandLine'))
                    	retry("db.command('DELETE EDGE ' + pc[0].getProperty('in_PendingType'))")
                  }
                  //print(Date() + ' End UAT update PC')
              }
              
          } 
          break;     */
  }

  return